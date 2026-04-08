export class TokenService {
  /**
   * Roughly estimates token count for a given text.
   * Standard rule of thumb: ~4 characters per token for English.
   */
  static estimateTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }

  /**
   * Estimates tokens for a set of files.
   */
  static estimateTotalTokens(contents: string[]): number {
    return contents.reduce((acc, curr) => acc + this.estimateTokens(curr), 0);
  }
}
