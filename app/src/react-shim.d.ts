// Упрощённые описания типов React (пакет @types/react в этой среде недоступен).
declare namespace React {
  type ReactNode = any;
  type CSSProperties = Record<string, string | number | undefined>;
  type Key = string | number;
  interface RefObject<T> { current: T | null }
  interface MutableRefObject<T> { current: T }
  type Dispatch<A> = (value: A) => void;
  type SetStateAction<S> = S | ((prev: S) => S);
  type SyntheticEvent<T = Element> = { target: any; currentTarget: T; preventDefault(): void; stopPropagation(): void; nativeEvent: any } & Record<string, any>;
  type ChangeEvent<T = Element> = SyntheticEvent<T>;
  type MouseEvent<T = Element> = SyntheticEvent<T> & { clientX: number; clientY: number; button: number; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean };
  type PointerEvent<T = Element> = MouseEvent<T> & { pointerId: number };
  type KeyboardEvent<T = Element> = SyntheticEvent<T> & { key: string; code: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean };
  type WheelEvent<T = Element> = MouseEvent<T> & { deltaY: number; deltaX: number };
  type FC<P = {}> = (props: P) => ReactNode;
}
declare module 'react' {
  export type ReactNode = React.ReactNode;
  export type CSSProperties = React.CSSProperties;
  export type RefObject<T> = React.RefObject<T>;
  export type MutableRefObject<T> = React.MutableRefObject<T>;
  export type FC<P = {}> = React.FC<P>;
  export type ChangeEvent<T = Element> = React.ChangeEvent<T>;
  export type MouseEvent<T = Element> = React.MouseEvent<T>;
  export type PointerEvent<T = Element> = React.PointerEvent<T>;
  export type KeyboardEvent<T = Element> = React.KeyboardEvent<T>;
  export type WheelEvent<T = Element> = React.WheelEvent<T>;
  export function useState<S>(initial: S | (() => S)): [S, React.Dispatch<React.SetStateAction<S>>];
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  export function useLayoutEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  export function useRef<T>(initial: T): React.MutableRefObject<T>;
  export function useRef<T>(initial: T | null): React.RefObject<T>;
  export function useMemo<T>(factory: () => T, deps: readonly unknown[]): T;
  export function useCallback<T extends (...args: any[]) => any>(fn: T, deps: readonly unknown[]): T;
  export function useReducer<S, A>(reducer: (s: S, a: A) => S, initial: S): [S, React.Dispatch<A>];
  export function useSyncExternalStore<T>(subscribe: (cb: () => void) => () => void, getSnapshot: () => T): T;
  export function memo<T>(component: T): T;
  export const Fragment: any;
}
declare module 'react/jsx-runtime' {
  export const jsx: any;
  export const jsxs: any;
  export const Fragment: any;
}
declare module 'react-dom/client' {
  export function createRoot(el: Element): { render(node: any): void; unmount(): void };
}
declare module '*.css';
declare namespace JSX {
  type Element = any;
  interface ElementChildrenAttribute { children: {} }
  interface IntrinsicAttributes { key?: string | number }
  interface IntrinsicElements { [tag: string]: any }
}
