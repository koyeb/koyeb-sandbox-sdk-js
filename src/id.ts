export function createArray<T>(length: number, init: (index: number) => T) {
  return Array(length)
    .fill(null)
    .map((_, index) => init(index));
}

export function randomFloat(max: number) {
  return Math.random() * max;
}

export function randomInteger(max: number) {
  return Math.floor(randomFloat(max));
}

export function randomItem<T>(items: T[]) {
  return items[randomInteger(items.length - 1)];
}

export function nanoId(alphabet: string) {
  const letters = alphabet.split('');

  return (length: number) => {
    return createArray(length, () => randomItem(letters)).join('');
  };
}

export const randomString = nanoId('-_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz');
