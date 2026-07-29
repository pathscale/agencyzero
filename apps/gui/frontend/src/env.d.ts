/// <reference types="@rsbuild/core/types" />

interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly PROD: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "*.css";
declare module "*.svg" {
  const src: string;
  export default src;
}
