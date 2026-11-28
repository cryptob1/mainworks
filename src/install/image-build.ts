/** Retry the image export pipe failure once; every other Docker diagnostic is preserved. */
export async function retryImagePipe(build: () => Promise<unknown>): Promise<void> {
  try { await build(); } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('io: read/write on closed pipe')) throw error;
    await build();
  }
}
