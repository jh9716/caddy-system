/**
 * 이 저장소에는 @types/react-dom 이 설치되어 있지 않다 (react-dom/client·server import도 같은 TS7016).
 * 인쇄 미리보기의 createPortal, 테스트의 renderToStaticMarkup 만 최소 타입으로 선언한다. 런타임 영향 없음.
 * 나중에 @types/react-dom 을 설치하면 이 파일은 지워도 된다.
 */
declare module "react-dom" {
  export function createPortal(
    children: import("react").ReactNode,
    container: Element | DocumentFragment,
    key?: null | string
  ): import("react").ReactPortal;
}

/** 테스트 스크립트들이 쓰는 renderToStaticMarkup 하나만 최소 타입 선언 (같은 이유). */
declare module "react-dom/server" {
  export function renderToStaticMarkup(element: import("react").ReactNode): string;
}
