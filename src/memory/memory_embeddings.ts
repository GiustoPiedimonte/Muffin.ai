import { createRequire } from "module";
const require = createRequire(import.meta.url);
const voyageai = require("voyageai");
const VoyageAIClient = voyageai.VoyageAIClient;

let client: any = null;

function getClient() {
    if (!client) {
        if (!process.env.VOYAGE_API_KEY) {
            throw new Error("VOYAGE_API_KEY is missing from environment variables.");
        }
        client = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY });
    }
    return client;
}

/**
 * Computes the embedding vector for the given text.
 * @param text The text to embed.
 * @param inputType "document" for saved facts/memories, "query" for search queries. Defaults to "document".
 */
export async function getEmbedding(
    text: string,
    inputType: "document" | "query" = "document"
): Promise<number[]> {
    const voyageClient = getClient();

    const response = await voyageClient.embed({
        input: [text],
        model: "voyage-3.5-lite",
        inputType: inputType,
    });

    const embedding = response.data?.[0]?.embedding;
    if (!embedding) {
        throw new Error("Failed to receive embedding from Voyage AI");
    }

    return embedding;
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
