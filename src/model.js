// The two readers in this tab, through transformers.js, on the CPU (WASM, several threads when
// the page is cross-origin isolated). Same 8-bit weights the tests measured. WebGPU was tried
// and left out: with these 8-bit weights it was slower than the CPU, and its slightly
// different arithmetic changed what Donut read.
import * as tf from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js';
import { reader, MODEL } from './reader.js';
import { ocr, OCR_MODEL } from './ocr.js';

tf.env.allowLocalModels = false;
tf.env.useBrowserCache = true;
// Development only: on localhost, load the model files the tests already downloaded.
if (location.hostname === 'localhost') {
  tf.env.allowLocalModels = true;
  tf.env.allowRemoteModels = false;
  tf.env.localModelPath = '/node_modules/@huggingface/transformers/.cache/';
}

export const SIZE_MB = MODEL.mb;
export const OCR_MB = OCR_MODEL.mb;
export const RawImage = tf.RawImage;

function progressOf(onProgress) {
  const files = new Map();
  return (e) => {
    if (e.status !== 'progress' || !e.total || !onProgress) return;
    files.set(e.file, [e.loaded, e.total]);
    let l = 0, t = 0;
    for (const [a, b] of files.values()) { l += a; t += b; }
    onProgress(l / t);
  };
}

function once(make) {
  let p = null;
  return (onProgress) => (p ??= make(progressOf(onProgress)).catch((err) => { p = null; throw err; }));
}

/** Donut: reads the receipt straight into lines. */
export const load = once((progress_callback) => reader(tf, { device: 'wasm', progress_callback }));

/** Florence-2's OCR: the second look, only for receipts whose first read does not add up. */
export const loadOcr = once((progress_callback) => ocr(tf, { device: 'wasm', progress_callback }));
