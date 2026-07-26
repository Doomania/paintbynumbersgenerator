# Paint by numbers generator — marker edition

Fork of **[drake7707/paintbynumbersgenerator](https://github.com/drake7707/paintbynumbersgenerator)** (MIT).
All upstream credit to drake7707. `LICENSE` is unchanged and applies to this fork.

Upstream turns a photo into a paint-by-numbers SVG. This fork makes the output
**paintable with alcohol and acrylic markers you already own** — the palette is
constrained to a real marker set, and the legend maps each number to a marker code
instead of a mixed paint pot.

---

## What's different

Four source edits, ~90 lines. Everything else is upstream, untouched.

### 1. Constrained-palette clustering (the actual fix)

Upstream already supports `kMeansColorRestrictions` — but it applies the restriction
**after** k-means has converged, in `updateKmeansOutputImageData`. Each centroid snaps
to its nearest allowed colour independently, so centroids that drifted close together
collapse onto the same marker. You ask for 24 colours and silently get 12.

This fork enforces the constraint **during** clustering:

- centroids are seeded from the k palette entries that actually cover the most image area
- point→cluster assignment uses **CIEDE2000**, not Euclidean LAB (ΔE76)
- after every averaging pass the centroid is projected onto the nearest **unclaimed**
  palette entry, so k distinct markers survive
- empty clusters are reseeded (capped at 15 iterations, always terminates)
- `k` is clamped to the palette size instead of silently duplicating

Measured on the same image, same seed, same LAB colour space:

| set | requested k | upstream | this fork |
|---|---|---|---|
| `posca-8` | 8 | **4** / 8 | **8** / 8 |
| `posca-16` | 16 | **7** / 16 | **13** / 16 |
| `posca-full-43` | 24 | **12** / 24 | **24** / 24 |

Cost: ~85ms → ~110ms on colour reduction at 400×400. The facet pipeline dominates
total runtime, so this is not noticeable.

`posca-16` reaching 13 rather than 16 is correct, not a shortfall — the three unused
markers are `PC-Y`, `PC-YL` and `PC-DG`, and the test image contains no yellow or dark
green. Forcing 16 would mean painting colours the photo does not have.

The most visible single improvement: on the test image the red circle renders as
**PC-R red** here and as **PC-BR brown** upstream. ΔE76 simply picked the wrong marker.

### 2. `src/lib/colordistance.ts` *(new)*

CIEDE2000 perceptual colour difference, verified against the Sharma / Wu / Dalal (2005)
reference dataset — matches to four decimal places. Plus
`nearestPaletteIndex(lab, palette, excluded)`.

ΔE76 over-weights blue separation and under-weights near-neutral warm tones, which is
exactly where skin lives. That is why faces get the wrong marker upstream.

### 3. Marker palettes — `palettes/`

`posca-43.json` — all 43 POSCA colours, with `posca-8`, `posca-16` and `posca-full-43`
subsets ready to use as `kMeansColorRestrictions`.

> Hex values are community-sourced **approximations of the physical ink**, not official
> manufacturer data. Swatch your own pens on your actual paper stock before relying on
> them. POSCA is a trademark of Mitsubishi Pencil Co., referenced descriptively only.

### 4. `tools/generate.js` — pipeline runner without the native dep

Replicates `src-cli/main.ts` but drops `canvas@2.5.0`, which does not build on modern
Node. Input is raw RGBA bytes; decode upstream with `sharp`, `jimp`, or the browser's
own canvas if you run this client-side.

### 5. Two upstream compile fixes

Not features — these block a build on any current toolchain:

- `src/common.ts` — `new Promise<void>` under `strict` (fails on TypeScript ≥ 4)
- `src/facetmanagement.ts` — import casing `./FacetBorderSegmenter` → `./facetBorderSegmenter`
  (works on Windows/macOS, breaks on any case-sensitive filesystem, including most CI)

---

## Build

```bash
npm install -D typescript@5.4
npx tsc -p tsconfig.test.json     # -> build-test/ (CommonJS, node-runnable)
```

`tsconfig.test.json` excludes `gui.ts`, `guiprocessmanager.ts`, `main.ts` and
`lib/clipboard.ts` — the browser-only files. The algorithm modules import nothing but
each other, so they lift cleanly into any front end.

The original browser build is unchanged: use `src/tsconfig.json` (AMD → `scripts/main.js`).

## Run

```bash
node tools/generate.js \
  --in photo.rgba --w 400 --h 400 \
  --palette palettes/posca-43.json --set posca-16 --k 16 \
  --minFacet 150 --maxFacets 60 --scale 3 \
  --out out/portrait
```

Outputs:

| file | what it is |
|---|---|
| `<out>-template.svg` | numbered outline, white fill — the file you print |
| `<out>-preview.svg` | filled with marker colours — what it should look like |
| `<out>-legend.json` | number → marker code, hex, % of area, region count, plus `markersNotNeeded` |

## Using a palette in the stock web UI

The upstream GUI already accepts colour restrictions. Set
`kMeansClusteringColorSpace` to `2` (LAB) — the default is `0` (RGB), which is the
single biggest quality regression in the stock config.

```json
{
  "kMeansNrOfClusters": 24,
  "kMeansClusteringColorSpace": 2,
  "kMeansColorRestrictions": ["PC-R", "PC-B", "PC-Y"],
  "colorAliases": { "PC-R": [232,32,32], "PC-B": [32,96,200], "PC-Y": [248,224,16] }
}
```

---

## Known limitation

Smooth gradients quantised into a constrained palette produce **ragged, finger-like band
edges** — clearly visible in the sky of the test output.

Raising `removeFacetsSmallerThanNrOfPoints` does **not** fix it (tested at 40 / 150 / 400).
Those fingers belong to one large connected facet, so facet-size pruning never sees them.
Upstream has the same artefact; this fork just uses more colours, so there are more of them.

The fix belongs upstream of quantization, not downstream:

- bilateral or mean-shift pre-smoothing before `applyKMeansClustering`, or
- a morphological open on `colormapResult.imgColorIndices` before `FacetCreator.getFacets`

Neither is implemented yet. It is the next thing to build.

---

## Roadmap

- [ ] pre-smoothing / morphological open to kill gradient band fingers
- [ ] bleed gutter between facets (alcohol markers bleed past the line)
- [ ] minimum facet size in **millimetres** derived from nib width + print size, not pixels
- [ ] A5–A2 print-ready PDF output at 300dpi
- [ ] more palettes: Ohuhu Acrylic, Molotow, Arrtx Acrylic, Copic
- [ ] browser Web Worker build (zero server compute)

## Upstream documentation

Every upstream setting still works exactly as documented in the
[original README](https://github.com/drake7707/paintbynumbersgenerator#readme).

## Licence

MIT, inherited from drake7707/paintbynumbersgenerator. See `LICENSE`.
