import { pipeline, type FeatureExtractionPipeline } from "@xenova/transformers";

// Use a lightweight, fast model for sentence embeddings
const MODEL_ID = "Xenova/all-MiniLM-L6-v2";

let extractor: FeatureExtractionPipeline | null = null;
let isLoading = false;

/**
 * Initializes and returns the feature extraction pipeline.
 * Ensures the model is only loaded once.
 */
async function getExtractor(): Promise<FeatureExtractionPipeline> {
    if (extractor) return extractor;

    if (isLoading) {
        // Simple wait if initialized concurrently
        while (isLoading) {
            await new Promise((r) => setTimeout(r, 100));
        }
        return extractor!;
    }

    isLoading = true;
    try {
        extractor = await pipeline("feature-extraction", MODEL_ID, {
            quantized: true, // Use quantized model for faster CPU inference
        });
        return extractor;
    } finally {
        isLoading = false;
    }
}

/**
 * Computes the embedding vector for the given text.
 */
export async function getEmbedding(text: string): Promise<number[]> {
    const ext = await getExtractor();
    const output = await ext(text, { pooling: "mean", normalize: true });

    // Output data is a Float32Array
    return Array.from(output.data as Float32Array);
}

/**
 * Calculates the cosine similarity between two vectors.
 * Since the vectors are normalized by `getEmbedding`, this is mostly a dot product.
 * Returns a value between -1 and 1, where 1 means identical direction.
 */
export function cosineSimilarity(vecA: number[], vecB: number[]): number {
    if (vecA.length !== vecB.length || vecA.length === 0) {
        return 0;
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }

    if (normA === 0 || normB === 0) return 0;

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}
