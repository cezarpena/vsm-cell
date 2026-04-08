import { kmeans } from 'ml-kmeans';
import crypto from 'crypto';
import { KuzuRepository } from '../db/repository.js';
import { LLMService } from '../services/llm.js';

export class HGAProcessor {
  private repo: KuzuRepository;
  private llm: LLMService;

  constructor() {
    this.repo = new KuzuRepository();
    this.llm = new LLMService();
  }

  async process(level = 0, targetClusterSize = 2): Promise<void> {
    console.log(`Starting HGA for Level ${level}...`);
    const entities = await this.repo.getEntitiesByLevel(level);
    
    if (entities.length <= targetClusterSize) {
      console.log(`Level ${level} has only ${entities.length} entities. HGA complete.`);
      return;
    }

    const embeddings = entities.map(e => e['e.embedding']);
    const numClusters = Math.max(1, Math.floor(entities.length / targetClusterSize));
    
    console.log(`Clustering ${entities.length} entities into ${numClusters} clusters...`);
    const clusters = kmeans(embeddings, numClusters, {});

    const clusteredEntities: Map<number, any[]> = new Map();
    for (let i = 0; i < clusters.clusters.length; i++) {
      const clusterIdx = clusters.clusters[i];
      if (!clusteredEntities.has(clusterIdx)) {
        clusteredEntities.set(clusterIdx, []);
      }
      clusteredEntities.get(clusterIdx)!.push(entities[i]);
    }

    for (const [clusterIdx, subEntities] of clusteredEntities.entries()) {
      console.log(`Synthesizing aggregated entity for cluster ${clusterIdx}...`);
      const simplifiedSubEntities = subEntities.map(e => ({
        name: e['e.name'],
        description: e['e.description']
      }));

      const aggregated = await this.llm.synthesizeEntity(simplifiedSubEntities);
      const aggregatedId = crypto.createHash('md5').update(aggregated.name + Date.now()).digest('hex');
      const embedding = await this.llm.getEmbedding(aggregated.name + ": " + aggregated.description);

      await this.repo.insertEntity(aggregatedId, aggregated.name, aggregated.description, level + 1, embedding);

      for (const sub of subEntities) {
        await this.repo.linkPartOf(sub['e.id'], aggregatedId);
      }
    }

    // Recurse to next level
    await this.process(level + 1, targetClusterSize);
  }
}
