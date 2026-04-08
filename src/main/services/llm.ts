import OpenAI from 'openai';
import * as dotenv from 'dotenv';

// Ensure environment variables are loaded
dotenv.config();

export interface Entity {
  name: string;
  description: string;
  relations: Array<{ target: string; type: string }>;
}

export class LLMService {
  private openai: OpenAI;
  private cerebras: OpenAI;
  private llmModel: string;
  private embeddingModel: string;

  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY || 'no-key-provided',
      baseURL: process.env.OPENAI_BASE_URL || undefined, // undefined uses the default https://api.openai.com/v1
    });
    
    // Cerebras for high-speed non-embedding LLM tasks
    this.cerebras = new OpenAI({
      apiKey: process.env.CEREBRAS_API_KEY || process.env.OPENAI_API_KEY || 'no-key-provided',
      baseURL: process.env.CEREBRAS_BASE_URL || 'https://api.cerebras.ai/v1',
    });

    this.llmModel = process.env.LLM_MODEL || 'gpt-oss-120b';
    this.embeddingModel = process.env.EMBEDDING_MODEL || 'text-embedding-3-large';
  }

  async extractEntities(chunkContent: string): Promise<Entity[]> {
    console.log(`[LLM] extractEntities called with ${chunkContent.length} chars using ${this.llmModel} (Cerebras)`);
    try {
      const response = await this.cerebras.chat.completions.create({
        model: this.llmModel,
        messages: [
          {
            role: 'system',
            content: 'Extract primary entities and their relations from the following text. Format as JSON object with an "entities" key containing an array of objects with "name", "description", and "relations" (array of {target, type}).'
          },
          {
            role: 'user',
            content: `Text: ${chunkContent}`
          }
        ],
        response_format: { type: 'json_object' }
      });
      
      const content = response.choices[0].message.content;
      console.log(`[LLM] Received content: ${content?.substring(0, 100)}...`);
      if (!content) return [];
      const parsed = JSON.parse(content);
      const entities = Array.isArray(parsed) ? parsed : (parsed.entities || []);
      console.log(`[LLM] Parsed ${entities.length} entities`);
      return entities;
    } catch (e: any) {
      console.error(`LLM extraction failed for model ${this.llmModel}:`, e.message || e);
      // Simple mock extraction: find capitalized words or words in quotes
      const entities: Entity[] = [];
      const words = chunkContent.match(/\b[A-Z][a-z]+\b/g) || [];
      const uniqueWords = [...new Set(words)];
      
      for (const word of uniqueWords.slice(0, 5)) {
        entities.push({
          name: word,
          description: `Extracted entity: ${word}`,
          relations: []
        });
      }
      return entities;
    }
  }

  async synthesizeEntity(subEntities: Array<{ name: string; description: string }>): Promise<{ name: string; description: string }> {
    try {
      const response = await this.cerebras.chat.completions.create({
        model: this.llmModel,
        messages: [
          {
            role: 'system',
            content: 'Synthesize a higher-level aggregated entity that encapsulates the provided sub-entities. Format as JSON object with "name" and "description".'
          },
          {
            role: 'user',
            content: `Sub-entities: ${JSON.stringify(subEntities)}`
          }
        ],
        response_format: { type: 'json_object' }
      });
      
      const content = response.choices[0].message.content;
      return content ? JSON.parse(content) : { name: "Unknown", description: "Empty synthesis" };
    } catch (e: any) {
      console.error(`LLM synthesis failed for model ${this.llmModel}:`, e.message || e);
      return {
        name: `Meso-node: ${subEntities[0]?.name || 'Unknown'}`,
        description: `Aggregated entity summarizing: ${subEntities.map(e => e.name).join(', ')}`
      };
    }
  }

  async generateInterClusterRelation(entityA: { name: string }, entityB: { name: string }): Promise<string> {
    try {
      const response = await this.cerebras.chat.completions.create({
        model: this.llmModel,
        messages: [
          {
            role: 'system',
            content: 'Identify the semantic relationship between two high-level entities. Return only a short relation type (e.g., INFLUENCES, RELATES_TO, COORDINATES).'
          },
          {
            role: 'user',
            content: `Entity A: ${entityA.name}\nEntity B: ${entityB.name}`
          }
        ],
        max_tokens: 10
      });
      return response.choices[0].message.content?.trim() || 'RELATES_TO';
    } catch (e: any) {
      console.error(`LLM relation generation failed for model ${this.llmModel}:`, e.message || e);
      return 'RELATES_TO';
    }
  }

  async generateAnswer(query: string, context: string): Promise<string> {
    try {
      const response = await this.cerebras.chat.completions.create({
        model: this.llmModel,
        messages: [
          {
            role: 'system',
            content: 'Based ONLY on the provided context, answer the following query. If the context is insufficient, say so.'
          },
          {
            role: 'user',
            content: `Query: ${query}\nContext: ${context}`
          }
        ]
      });
      return response.choices[0].message.content || "I couldn't generate an answer.";
    } catch (e: any) {
      console.error(`LLM generateAnswer failed for model ${this.llmModel}:`, e.message || e);
      return `Context was retrieved but LLM generation failed or OpenAI not reachable (${e.message}).`;
    }
  }

  async planSearch(query: string, summary: string): Promise<string[]> {
    try {
      const response = await this.cerebras.chat.completions.create({
        model: this.llmModel,
        messages: [
          {
            role: 'system',
            content: 'Analyze the query and the project summary. Identify which file names (exactly as listed) are likely to contain the specific information needed to answer the query. Return a JSON object with a "files" key containing an array of strings. Maximum 3 files.'
          },
          {
            role: 'user',
            content: `Query: ${query}\nSummary: ${summary}`
          }
        ],
        response_format: { type: 'json_object' }
      });
      
      const content = response.choices[0].message.content;
      if (!content) return [];
      const parsed = JSON.parse(content);
      return parsed.files || [];
    } catch (e: any) {
      console.error(`LLM planSearch failed:`, e);
      return [];
    }
  }

  async getEmbedding(text: string): Promise<number[]> {
    console.log(`[LLM] getEmbedding called for: ${text.substring(0, 50)}...`);
    try {
      // Use the 'dimensions' parameter if using OpenAI's '3' models, otherwise truncate to 1024 as per HKG schema
      const useDimensions = this.embeddingModel.includes('text-embedding-3');
      
      const response = await this.openai.embeddings.create({
        model: this.embeddingModel,
        input: text,
        dimensions: useDimensions ? 1024 : undefined
      });
      
      let embedding = response.data[0].embedding;
      console.log(`[LLM] Received embedding of length ${embedding.length}`);
      
      // Safety truncation/padding for non-OpenAI models or if dimensions param is ignored
      if (embedding.length > 1024) {
        embedding = embedding.slice(0, 1024);
      } else if (embedding.length < 1024) {
        embedding = [...embedding, ...Array(1024 - embedding.length).fill(0)];
      }
      
      return embedding;
    } catch (e: any) {
      console.error(`Embedding generation failed for model ${this.embeddingModel}:`, e.message || e);
      // Mock 1024-dim embedding
      return Array(1024).fill(0).map(() => Math.random());
    }
  }
}
