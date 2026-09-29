import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

// Optional second-language captions, so a demo in one language can be followed in another
// (for example a Spanish conversation with English subtitles). Off unless SIM_CAPTION_LANGUAGE is set.
const target = process.env.SIM_CAPTION_LANGUAGE;
const modelId = process.env.SIM_CAPTION_MODEL_ID ?? 'global.amazon.nova-2-lite-v1:0';
const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? 'us-east-1' });

export const captionsEnabled = Boolean(target);

export async function translateCaption(text: string): Promise<string | undefined> {
  if (!target) return undefined;
  const response = await bedrock.send(
    new ConverseCommand({
      modelId,
      system: [
        {
          text:
            `Translate what the user sends into natural, spoken ${target}, keeping names as written. ` +
            'Reply with the translation only: no quotes, notes or explanations.'
        }
      ],
      messages: [{ role: 'user', content: [{ text }] }],
      inferenceConfig: { maxTokens: 300, temperature: 0 }
    })
  );
  return response.output?.message?.content
    ?.map(block => block.text ?? '')
    .join(' ')
    .trim();
}
