import fs from 'fs/promises';
import path from 'path';
import { LLMService } from './llm.js';

export interface RestructureResult {
  success: boolean;
  message: string;
}

export class RestructuringService {
  private llm: LLMService;

  constructor() {
    this.llm = new LLMService();
  }

  /**
   * Automatically organizes files into a hierarchical structure.
   */
  async autoRestructure(watchDir: string, fileSummaries: any[]): Promise<RestructureResult> {
    console.log(`[RESTRUCTURER] Starting auto-restructuring for ${watchDir}...`);
    
    try {
      const metadata = fileSummaries.map(s => ({
        fileName: s.fileName,
        summary: s.summary,
        relPath: s.filePath
      }));

      const prompt = `
        You are an expert folder architect. The current folder is too large (over 100k tokens).
        
        Files in this folder:
        ${JSON.stringify(metadata, null, 2)}

        Instructions:
        1. Group these files into 2-4 logical sub-folders based on their themes or topics.
        2. Give each sub-folder a clear, professional name.
        3. Assign each file to one of these sub-folders.
        
        Format your response as a JSON object with a "structure" key containing an array of objects:
        {
          "structure": [
            {
              "folderName": "Logic_Core",
              "files": ["file1.md", "file2.md"]
            },
            ...
          ]
        }
      `;

      const response = await this.llm.generateAnswer(prompt, "Restructuring Plan");
      // Extract JSON if model returned text around it
      const jsonStr = response.match(/\{[\s\S]*\}/)?.[0];
      if (!jsonStr) throw new Error("Could not parse restructuring plan from LLM.");

      const plan = JSON.parse(jsonStr).structure;
      console.log(`[RESTRUCTURER] Plan received: ${JSON.stringify(plan)}`);

      for (const group of plan) {
        const subDir = path.join(watchDir, group.folderName);
        await fs.mkdir(subDir, { recursive: true });

        for (const fileName of group.files) {
          const oldPath = path.join(watchDir, fileName);
          const newPath = path.join(subDir, fileName);
          
          try {
            await fs.rename(oldPath, newPath);
            console.log(`[RESTRUCTURER] Moved ${fileName} to ${group.folderName}`);
          } catch (e) {
            console.error(`[RESTRUCTURER] Failed to move ${fileName}:`, e);
          }
        }
      }

      return { success: true, message: "Hierarchy created and files distributed." };
    } catch (e: any) {
      console.error(`[RESTRUCTURER] Error during auto-restructure:`, e);
      return { success: false, message: e.message || "Unknown error" };
    }
  }
}
