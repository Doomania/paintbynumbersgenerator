/**
 * Marker-PBN pipeline runner.
 *
 * Replicates src-cli/main.ts but WITHOUT the `canvas` native dependency
 * (canvas@2.5.0 does not build on modern Node), and outputs marker-oriented
 * deliverables instead of generic paint ones:
 *
 *   <name>-template.svg   numbered outline, white fill  -> the thing you print
 *   <name>-preview.svg    filled with marker colours    -> what it should look like
 *   <name>-legend.json    number -> marker code, hex, % of area
 *
 * Usage:
 *   node tools/generate.js --in photo.rgba --w 400 --h 400 \
 *        --palette palettes/posca-43.json --set posca-16 --k 16 --out out/portrait
 *
 * Input is raw RGBA bytes (decode your PNG/JPEG upstream — sharp, jimp, or the
 * browser's own canvas when you run this client-side).
 */
const fs = require("fs");
const path = require("path");

const B = process.env.PBN_BUILD || path.join(__dirname, "..", "build-test");
const { ColorReducer } = require(path.join(B, "colorreductionmanagement.js"));
const { Settings } = require(path.join(B, "settings.js"));
const { FacetCreator } = require(path.join(B, "facetCreator.js"));
const { FacetReducer } = require(path.join(B, "facetReducer.js"));
const { FacetBorderTracer } = require(path.join(B, "facetBorderTracer.js"));
const { FacetBorderSegmenter } = require(path.join(B, "facetBorderSegmenter.js"));
const { FacetLabelPlacer } = require(path.join(B, "facetLabelPlacer.js"));
const { FacetResult } = require(path.join(B, "facetmanagement.js"));

function arg(name, def) {
    const i = process.argv.indexOf("--" + name);
    return i === -1 ? def : process.argv[i + 1];
}

function buildSVG(facetResult, colorsByIndex, mult, fill, stroke, labels, fontSize, fontColor) {
    const w = mult * facetResult.width, h = mult * facetResult.height;
    let out = `<?xml version="1.0" standalone="no"?>\n<svg width="${w}" height="${h}" ` +
              `viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">` +
              `<rect width="100%" height="100%" fill="#fff"/>`;
    for (const f of facetResult.facets) {
        if (f == null || f.borderSegments.length === 0) { continue; }
        const p = f.getFullPathFromBorderSegments(false);
        if (p[0].x !== p[p.length - 1].x || p[0].y !== p[p.length - 1].y) { p.push(p[0]); }
        let d = "M " + p[0].x * mult + " " + p[0].y * mult + " ";
        for (let i = 1; i < p.length; i++) {
            d += "Q " + ((p[i].x + p[i - 1].x) / 2 * mult) + " " + ((p[i].y + p[i - 1].y) / 2 * mult) +
                 " " + (p[i].x * mult) + " " + (p[i].y * mult) + " ";
        }
        const c = colorsByIndex[f.color];
        const svgFill = fill ? `rgb(${c[0]},${c[1]},${c[2]})` : "none";
        const svgStroke = stroke ? "#000" : (fill ? `rgb(${c[0]},${c[1]},${c[2]})` : "");
        out += `<path d="${d}" style="fill:${svgFill};` +
               (svgStroke ? `stroke:${svgStroke};stroke-width:1px` : "") + `"/>`;
        if (labels) {
            const digits = ("" + f.color).length;
            out += `<g transform="translate(${f.labelBounds.minX * mult},${f.labelBounds.minY * mult})">` +
                   `<svg width="${f.labelBounds.width * mult}" height="${f.labelBounds.height * mult}" ` +
                   `overflow="visible" viewBox="-50 -50 100 100" preserveAspectRatio="xMidYMid meet">` +
                   `<text font-family="Tahoma" font-size="${fontSize / digits}" dominant-baseline="middle" ` +
                   `text-anchor="middle" fill="${fontColor}">${f.color}</text></svg></g>`;
        }
    }
    return out + `</svg>`;
}

(async () => {
    const W = parseInt(arg("w", "400")), H = parseInt(arg("h", "400"));
    const raw = fs.readFileSync(arg("in"));
    const pal = JSON.parse(fs.readFileSync(arg("palette"), "utf8"));
    const setName = arg("set");
    const outBase = arg("out", "out/result");
    fs.mkdirSync(path.dirname(outBase), { recursive: true });

    const s = new Settings();
    s.randomSeed = parseInt(arg("seed", "7707"));
    s.kMeansNrOfClusters = parseInt(arg("k", "16"));
    s.colorAliases = pal.colorAliases;
    s.kMeansColorRestrictions = pal.sets[setName].slice();
    s.removeFacetsSmallerThanNrOfPoints = parseInt(arg("minFacet", "40"));
    s.maximumNumberOfFacets = parseInt(arg("maxFacets", "300"));
    s.narrowPixelStripCleanupRuns = 3;
    s.nrOfTimesToHalveBorderSegments = 2;

    const imgData = { width: W, height: H, data: new Uint8ClampedArray(raw) };
    const kmeansImgData = { width: W, height: H, data: new Uint8ClampedArray(raw) };

    await ColorReducer.applyKMeansClustering(imgData, kmeansImgData, null, s, null);
    const colormapResult = ColorReducer.createColorMap(kmeansImgData);

    let facetResult = new FacetResult();
    for (let run = 0; run < s.narrowPixelStripCleanupRuns; run++) {
        await ColorReducer.processNarrowPixelStripCleanup(colormapResult);
        facetResult = await FacetCreator.getFacets(W, H, colormapResult.imgColorIndices, () => {});
        await FacetReducer.reduceFacets(s.removeFacetsSmallerThanNrOfPoints, s.removeFacetsFromLargeToSmall,
            s.maximumNumberOfFacets, colormapResult.colorsByIndex, facetResult, colormapResult.imgColorIndices, () => {});
    }
    await FacetBorderTracer.buildFacetBorderPaths(facetResult, () => {});
    await FacetBorderSegmenter.buildFacetBorderSegments(facetResult, s.nrOfTimesToHalveBorderSegments, () => {});
    await FacetLabelPlacer.buildFacetLabelBounds(facetResult, () => {});

    const mult = parseInt(arg("scale", "3"));
    fs.writeFileSync(outBase + "-template.svg",
        buildSVG(facetResult, colormapResult.colorsByIndex, mult, false, true, true, 50, "#333"));
    fs.writeFileSync(outBase + "-preview.svg",
        buildSVG(facetResult, colormapResult.colorsByIndex, mult, true, false, false, 50, "#333"));

    // legend: number -> marker code
    const rgbToName = new Map(Object.entries(pal.colorAliases).map(([n, v]) => [v.join(","), n]));
    const freq = colormapResult.colorsByIndex.map(() => 0);
    let facetCount = colormapResult.colorsByIndex.map(() => 0);
    for (const f of facetResult.facets) {
        if (f !== null) { freq[f.color] += f.pointCount; facetCount[f.color]++; }
    }
    const totalPts = freq.reduce((a, b) => a + b, 0);
    const legend = colormapResult.colorsByIndex.map((c, i) => ({
        number: i,
        marker: rgbToName.get(c.join(",")) || null,
        rgb: c,
        hex: "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase(),
        areaPercent: +(freq[i] / totalPts * 100).toFixed(2),
        regions: facetCount[i],
    })).filter((e) => e.regions > 0).sort((a, b) => b.areaPercent - a.areaPercent);

    const owned = new Set(pal.sets[setName]);
    fs.writeFileSync(outBase + "-legend.json", JSON.stringify({
        brand: pal._brand, set: setName, requestedColors: s.kMeansNrOfClusters,
        actualColors: legend.length, totalRegions: facetResult.facets.filter((f) => f !== null).length,
        markersNotNeeded: [...owned].filter((n) => !legend.some((e) => e.marker === n)),
        legend,
    }, null, 2));

    console.log(`${legend.length} colours / ${facetResult.facets.filter((f) => f !== null).length} regions -> ${outBase}-*.{svg,json}`);
})().catch((e) => { console.error(e); process.exit(1); });
