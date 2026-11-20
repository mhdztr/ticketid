let nowFn: () => Date = () => new Date();

export const clock = {
  now: (): Date => nowFn(),
};

export function setClock(fn: () => Date): void {
  nowFn = fn;
}

export function resetClock(): void {
  nowFn = () => new Date();
}
