/**
 * A model that cannot read images fails the whole turn over one picture, and the
 * screenshot on a page mention is the likely one: the text beside it is what mattered
 * and can still go. There is no reliable list of which models can see, so the provider
 * says: on a refusal the images come out and the request goes again, and that model
 * is not asked twice in this run.
 */
import { toast } from "@/components/ui/toast";

const NOTE = "[image omitted: this model cannot read images]";
/** Cheap enough to run on every request, and a body without one skips the parse. */
const HAS_IMAGE = /"type":"(?:image_url|input_image|image)"|"inline_?[dD]ata"/;

const blind = new Set<string>();

/** Whether a provider's error text means "no images here". */
export function rejectsImages(raw: string): boolean {
  const msg = raw.toLowerCase();
  return (
    msg.includes("image input") ||
    (msg.includes("no endpoints") && msg.includes("image")) ||
    msg.includes("does not support image") ||
    msg.includes("image_url") ||
    /\bvision\b/.test(msg)
  );
}

/** Each format's image part becomes that format's text part, so a message that was
 *  only a picture still has a body. */
export function stripImages(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripImages);
  if (!value || typeof value !== "object") return value;
  const part = value as Record<string, unknown>;
  if (part.type === "input_image") return { type: "input_text", text: NOTE };
  if (part.type === "image_url" || part.type === "image") return { type: "text", text: NOTE };
  if (part.inlineData || part.inline_data) return { text: NOTE };
  return Object.fromEntries(Object.entries(part).map(([k, v]) => [k, stripImages(v)]));
}

function withoutImages(body: string): string | null {
  try {
    return JSON.stringify(stripImages(JSON.parse(body)));
  } catch {
    return null;
  }
}

function modelOf(body: string, input: RequestInfo | URL): string {
  const named = /"model":"([^"]+)"/.exec(body)?.[1];
  return named ?? String(input instanceof Request ? input.url : input);
}

export function withImageFallback(fetchFn: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    const body = init?.body;
    if (typeof body !== "string" || !HAS_IMAGE.test(body)) return fetchFn(input, init);
    const model = modelOf(body, input);
    const bare = blind.has(model) ? withoutImages(body) : null;
    if (bare) return fetchFn(input, { ...init, body: bare });

    const res = await fetchFn(input, init);
    if (res.status < 400 || res.status >= 500) return res;
    if (!rejectsImages(await res.clone().text())) return res;
    const retry = withoutImages(body);
    if (!retry) return res;
    blind.add(model);
    toast("This model cannot read images, so only the text was sent.", { variant: "info" });
    return fetchFn(input, { ...init, body: retry });
  };
}
