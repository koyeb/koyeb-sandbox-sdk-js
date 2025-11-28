export interface TypedEventTarget<EventMap extends Record<string, Event>> extends EventTarget {
  addEventListener<K extends keyof EventMap>(
    type: K,
    listener: (this: EventSource, ev: EventMap[K]) => any,
    options?: boolean | AddEventListenerOptions,
  ): void;

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;

  removeEventListener<K extends keyof EventMap>(
    type: K,
    listener: (this: EventSource, ev: EventMap[K]) => any,
    options?: boolean | EventListenerOptions,
  ): void;

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void;

  dispatchEvent(event: EventMap[keyof EventMap]): boolean;
}
