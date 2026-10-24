// Reads a receipt photo with Donut. Shared by the browser and the tests, so both run the
// same model, the same quantisation and the same decoding.
// The caller passes in transformers.js (from jsDelivr in the browser, from npm in Node).
import { PROMPT } from './donut.js';

export const MODEL = {
  id: 'Xenova/donut-base-finetuned-cord-v2',
  dtype: 'q8',
  mb: 219,
};

/** @returns {Promise<(image: object) => Promise<string>>} a function from RawImage to Donut's tag sequence */
export async function reader(tf, { device, threads, progress_callback } = {}) {
  const processor = await tf.AutoProcessor.from_pretrained(MODEL.id, { progress_callback });
  const tokenizer = await tf.AutoTokenizer.from_pretrained(MODEL.id, { progress_callback });
  const session_options = threads ? { intraOpNumThreads: threads } : undefined;
  const model = await tf.VisionEncoderDecoderModel.from_pretrained(MODEL.id, { dtype: MODEL.dtype, device, session_options, progress_callback });
  const prompt = tokenizer(PROMPT, { add_special_tokens: false }).input_ids;

  return async (image) => {
    const { pixel_values } = await processor(image);
    const out = await model.generate({ inputs: pixel_values, decoder_input_ids: prompt, max_length: 768, do_sample: false });
    return tokenizer.batch_decode(out, { skip_special_tokens: false })[0];
  };
}
