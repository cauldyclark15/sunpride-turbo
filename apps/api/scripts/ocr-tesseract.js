// F-306 Linux OCR adapter for SUNPRIDE_OCR_COMMAND: same contract as ocr.swift.
// Original bytes on stdin → {modelVersion,text,observations:[{page,text,confidence}]} on stdout.
// Local only (tesseract + pdftoppm on this host); no image or recognised fact leaves it. No shell.
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const MODEL_VERSION = "tesseract-eng/v1";
const MAX_PAGES = 8;

/** Tesseract TSV (one per page) → the ocr.swift JSON shape. Rows keep reading order; one observation per text line.
 * @param {string[]} pages */
export function resultFromTsv(pages) {
  /** @type {{page:number,text:string,confidence:number}[]} */
  const observations = [];
  /** @type {string[]} */
  const lines = [];
  pages.forEach((tsv, index) => {
    /** @type {Map<string,{words:string[],conf:number[]}>} */
    const rows = new Map();
    for (const raw of tsv.split(/\r?\n/).slice(1)) {
      const f = raw.split("\t");
      if (f.length < 12 || f[0] !== "5") continue; // level 5 = word
      const word = f.slice(11).join("\t").trim();
      const conf = Number(f[10]);
      if (!word || !Number.isFinite(conf) || conf < 0) continue;
      const key = `${f[2]}.${f[3]}.${f[4]}`; // block.paragraph.line
      const row = rows.get(key) ?? { words: [], conf: [] };
      row.words.push(word);
      row.conf.push(conf);
      rows.set(key, row);
    }
    for (const row of rows.values()) {
      // Tesseract often reads a printed hyphen as an en/em dash; the PO field patterns expect "-".
      const text = row.words.join(" ").replace(/[\u2010-\u2015\u2212]/g, "-");
      const confidence =
        Math.round(
          (row.conf.reduce((a, b) => a + b, 0) / row.conf.length) * 10,
        ) / 1000;
      lines.push(text);
      observations.push({ page: index + 1, text, confidence });
    }
  });
  return { modelVersion: MODEL_VERSION, text: lines.join("\n"), observations };
}

/** @param {string[]} cmd */
async function run(cmd) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  if (code !== 0) throw new Error(`${cmd[0]} failed`);
  return out;
}

/** @param {Uint8Array} bytes */
export async function recognise(bytes) {
  const dir = await mkdtemp(join(tmpdir(), "sp-ocr-"));
  try {
    /** @type {string[]} */
    let images;
    if (new TextDecoder().decode(bytes.slice(0, 4)) === "%PDF") {
      const pdf = join(dir, "in.pdf");
      await Bun.write(pdf, bytes);
      const info = await run(["pdfinfo", pdf]);
      const count = Number(/^Pages:\s+(\d+)/m.exec(info)?.[1] ?? 0);
      if (!count || count > MAX_PAGES) throw new Error("pages");
      await run(["pdftoppm", "-r", "200", "-gray", "-png", pdf, join(dir, "p")]);
      images = (await readdir(dir))
        .filter((n) => /^p-\d+\.png$/.test(n))
        .sort((a, b) => Number(/\d+/.exec(a)?.[0]) - Number(/\d+/.exec(b)?.[0]))
        .map((n) => join(dir, n));
    } else {
      const img = join(dir, "in.img");
      await Bun.write(img, bytes);
      images = [img];
    }
    const pages = [];
    for (const img of images)
      pages.push(
        await run(["tesseract", img, "stdout", "-l", "eng", "--psm", "4", "tsv"]),
      );
    return resultFromTsv(pages);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const bytes = new Uint8Array(await new Response(Bun.stdin.stream()).arrayBuffer());
  if (!bytes.length || bytes.length > 40 * 1024 * 1024) process.exit(2);
  try {
    process.stdout.write(JSON.stringify(await recognise(bytes)));
  } catch {
    process.exit(2);
  }
}
