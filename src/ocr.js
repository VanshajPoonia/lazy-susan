// Reads a receipt photo with Florence-2's OCR: every piece of text and where it is. Shared by
// the browser and the tests. src/rows.js turns the pieces into lines with prices.
// The caller passes in transformers.js (from jsDelivr in the browser, from npm in Node).

export const OCR_MODEL = {
  id: 'onnx-community/Florence-2-base-ft',
  dtype: 'q8',
  mb: 266,
};

const TASK = '<OCR_WITH_REGION>';

/** @returns {Promise<(image: object) => Promise<{ text: string[], quads: number[][], width: number, height: number }>>} */
export async function ocr(tf, { device, threads, progress_callback } = {}) {
  const session_options = threads ? { intraOpNumThreads: threads } : undefined;
  const model = await tf.Florence2ForConditionalGeneration.from_pretrained(OCR_MODEL.id, { dtype: OCR_MODEL.dtype, device, session_options, progress_callback });
  const processor = await tf.AutoProcessor.from_pretrained(OCR_MODEL.id, { progress_callback });
  const prompts = processor.construct_prompts(TASK);
  return async (image) => {
    const inputs = await processor(image, prompts);
    const ids = await model.generate({ ...inputs, max_new_tokens: 1024, num_beams: 1 });
    const raw = processor.batch_decode(ids, { skip_special_tokens: false })[0];
    const res = processor.post_process_generation(raw, TASK, image.size)[TASK];
    return { text: res.labels.map((l) => l.replace(/<\/?s>/g, '').trim()), quads: res.quad_boxes, width: image.width, height: image.height };
  };
}
