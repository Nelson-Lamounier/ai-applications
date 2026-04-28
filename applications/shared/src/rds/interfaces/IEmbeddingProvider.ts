/**
 * @format
 * IEmbeddingProvider — Text Embedding Contract
 *
 * Converts raw text into a fixed-dimension float32 vector.
 * The pipeline never imports a concrete model client — it calls this interface.
 * Swap Titan for Cohere or any other model by providing a different implementation.
 */

export interface IEmbeddingProvider {
    /**
     * Embed a single text string.
     * Returns a float32 vector of length `this.dimension`.
     */
    embed(text: string): Promise<number[]>;

    /**
     * Output vector dimension.
     * Must match the `vector(N)` column in the Aurora schema.
     *   Titan Embed Text v2 → 1024
     */
    readonly dimension: number;
}
