/** Replaces `Date.now` with a manual clock for the duration of `run`. */
export async function withClock(
  run: (advance: (ms: number) => void) => void | Promise<void>,
): Promise<void> {
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    await run((ms) => {
      now += ms;
    });
  } finally {
    Date.now = realNow;
  }
}
