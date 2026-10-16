export interface DesktopApi {
  platform: NodeJS.Platform;
}

declare global {
  interface Window {
    desktop: DesktopApi;
  }
}
