import fs from 'fs/promises';
import path from 'path';
import matter from 'gray-matter';
import { PDFParse } from 'pdf-parse';

export interface ParsedDocument {
  content: string;
  metadata: Record<string, any>;
}

export class DocumentParser {
  async parse(filePath: string): Promise<ParsedDocument> {
    const ext = path.extname(filePath).toLowerCase();
    const buffer = await fs.readFile(filePath);

    if (ext === '.md' || ext === '.markdown') {
      const { content, data } = matter(buffer);
      return { content, metadata: data };
    } else if (ext === '.pdf') {
      try {
        const parser = new PDFParse({ data: buffer });
        const textResult = await parser.getText();
        const infoResult = await parser.getInfo();
        return { content: textResult.text, metadata: infoResult.info || {} };
      } catch (e) {
        console.error(`Failed to parse PDF ${filePath}:`, e);
        return { content: "", metadata: { error: "Failed to parse PDF" } };
      }
    } else if (ext === '.txt') {
      return { content: buffer.toString(), metadata: {} };
    } else {
      throw new Error(`Unsupported file extension: ${ext}`);
    }
  }
}
