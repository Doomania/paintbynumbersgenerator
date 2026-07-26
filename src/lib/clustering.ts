import { Random } from "../random";
import { ciede2000, nearestPaletteIndex } from "./colordistance";

export class Vector {

    public tag:any;
    
    constructor(public values: number[], public weight: number = 1) { }

    public distanceTo(p: Vector): number {
        let sumSquares = 0;
        for (let i: number = 0; i < this.values.length; i++) {
            sumSquares += (p.values[i] - this.values[i]) * (p.values[i] - this.values[i]);
        }

        return Math.sqrt(sumSquares);
    }

    /**
     *  Calculates the weighted average of the given points
     */
    public static average(pts: Vector[]): Vector {
        if (pts.length === 0) {
            throw Error("Can't average 0 elements");
        }

        const dims = pts[0].values.length;
        const values = [];
        for (let i: number = 0; i < dims; i++) {
            values.push(0);
        }

        let weightSum = 0;
        for (const p of pts) {
            weightSum += p.weight;

            for (let i: number = 0; i < dims; i++) {
                values[i] += p.weight * p.values[i];
            }
        }

        for (let i: number = 0; i < values.length; i++) {
            values[i] /= weightSum;
        }

        return new Vector(values);
    }
}

export class KMeans {

    /** PATCH: hard cap on empty-cluster reseeding so the loop always terminates. */
    private static readonly MAX_RESEED_ITERATIONS = 15;

    public currentIteration: number = 0;
    public pointsPerCategory: Vector[][] = [];

    public centroids: Vector[] = [];
    public currentDeltaDistanceDifference: number = 0;

    /**
     * PATCH: when `palette` is supplied, every centroid is constrained to be an
     * actual palette entry (a real marker colour) at every iteration, and no two
     * centroids may claim the same entry. `palette` must be in the same colour
     * space as the point vectors (LAB when a palette is used).
     */
    constructor(private points: Vector[], public k: number, private random: Random,
                centroids: Vector[] | null = null,
                public palette: number[][] | null = null) {

        if (this.palette !== null && this.k > this.palette.length) {
            this.k = this.palette.length;
        }

        if (centroids != null) {
            this.centroids = centroids;
            for (let i: number = 0; i < this.k; i++) {
                this.pointsPerCategory.push([]);
            }
        } else if (this.palette !== null) {
            this.initCentroidsFromPalette(this.palette);
        } else {
            this.initCentroids();
        }
    }

    private initCentroids() {
        for (let i: number = 0; i < this.k; i++) {
            this.centroids.push(this.points[Math.floor(this.points.length * this.random.next())]);
            this.pointsPerCategory.push([]);
        }
    }

    /**
     * PATCH: seed from the k palette entries that actually cover the most image
     * area. Deterministic, collision-free, and far better than random seeding
     * because it never wastes a slot on a marker the photo does not contain.
     */
    private initCentroidsFromPalette(palette: number[][]) {
        const coverage: number[] = new Array(palette.length).fill(0);
        for (const p of this.points) {
            const idx = nearestPaletteIndex(p.values, palette);
            coverage[idx] += p.weight;
        }
        const ranked = coverage
            .map((w, i) => ({ w, i }))
            .sort((a, b) => b.w - a.w || a.i - b.i);

        for (let i: number = 0; i < this.k; i++) {
            this.centroids.push(new Vector(palette[ranked[i].i].slice()));
            this.pointsPerCategory.push([]);
        }
    }

    public step() {
        // PATCH: worst-served point of this pass, used for empty-cluster recovery
        let worstPoint: Vector | null = null;
        let worstScore = -1;

        // clear category
        for (let i: number = 0; i < this.k; i++) {
            this.pointsPerCategory[i] = [];
        }

        // calculate points per centroid
        for (const p of this.points) {
            let minDist = Number.MAX_VALUE;
            let centroidIndex: number = -1;
            for (let k: number = 0; k < this.k; k++) {
                // PATCH: perceptual distance (CIEDE2000) when palette-constrained.
                // Euclidean LAB (deltaE76) mis-assigns near-neutral warm tones -> skin.
                const dist = this.palette !== null
                    ? ciede2000(this.centroids[k].values, p.values)
                    : this.centroids[k].distanceTo(p);
                if (dist < minDist) {
                    centroidIndex = k;
                    minDist = dist;

                }
            }
            this.pointsPerCategory[centroidIndex].push(p);

            // PATCH: remember the worst-served colour. Costs nothing here (minDist is
            // already computed) and lets empty-cluster recovery below run in O(1).
            const badness = minDist * p.weight;
            if (badness > worstScore) { worstScore = badness; worstPoint = p; }
        }

        let totalDistanceDiff = 0;
        // PATCH: guarantees k *distinct* palette entries survive the projection
        const claimed = new Set<number>();

        // adjust centroids
        for (let k: number = 0; k < this.pointsPerCategory.length; k++) {
            const cat = this.pointsPerCategory[k];
            if (cat.length > 0) {
                let avg = Vector.average(cat);

                // PATCH: project the free centroid onto the nearest UNCLAIMED palette
                // entry, inside the loop, so clustering optimises around colours the
                // user can actually buy instead of snapping after the fact.
                if (this.palette !== null) {
                    const idx = nearestPaletteIndex(avg.values, this.palette, claimed);
                    claimed.add(idx);
                    avg = new Vector(this.palette[idx].slice());
                }

                const dist = this.centroids[k].distanceTo(avg);
                totalDistanceDiff += dist;
                this.centroids[k] = avg;
            } else if (this.palette !== null && this.currentIteration < KMeans.MAX_RESEED_ITERATIONS) {
                // PATCH: empty-cluster recovery. A dead centroid silently wastes one of
                // the user's markers, which is how "I asked for 24 and got 12" happens.
                // Reseed it onto the unclaimed palette entry nearest the worst-served
                // colour in the image. Capped by iteration count so this always converges.
                if (worstPoint !== null) {
                    const idx = nearestPaletteIndex(worstPoint.values, this.palette, claimed);
                    if (!claimed.has(idx)) {
                        claimed.add(idx);
                        const seeded = new Vector(this.palette[idx].slice());
                        totalDistanceDiff += this.centroids[k].distanceTo(seeded);
                        this.centroids[k] = seeded;
                    }
                }
            }
        }
        this.currentDeltaDistanceDifference = totalDistanceDiff;

        this.currentIteration++;
    }
}
