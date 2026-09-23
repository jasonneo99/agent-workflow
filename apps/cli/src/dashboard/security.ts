export function serializeInlineScriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/gu, (character) => `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`);
}

export function publicHttpError(message: string): string {
  return message;
}
