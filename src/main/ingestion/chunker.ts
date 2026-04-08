export interface Chunk {
  content: string;
  tokenCount: number;
}

export class SemanticChunker {
  private targetTokenSize: number;

  constructor(targetTokenSize = 500) {
    this.targetTokenSize = targetTokenSize;
  }

  // Simple approximation of token count (4 characters per token)
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  chunk(content: string): Chunk[] {
    // Split by double newlines or Markdown headers
    const segments = content.split(/\n\n+|(?=^#+ )/m);
    const chunks: Chunk[] = [];
    let currentChunk = '';

    for (const segment of segments) {
      if (this.estimateTokens(currentChunk + segment) > this.targetTokenSize && currentChunk !== '') {
        chunks.push({
          content: currentChunk.trim(),
          tokenCount: this.estimateTokens(currentChunk)
        });
        currentChunk = segment;
      } else {
        currentChunk += (currentChunk ? '\n\n' : '') + segment;
      }
    }

    if (currentChunk.trim() !== '') {
      chunks.push({
        content: currentChunk.trim(),
        tokenCount: this.estimateTokens(currentChunk)
      });
    }

    return chunks;
  }
}
