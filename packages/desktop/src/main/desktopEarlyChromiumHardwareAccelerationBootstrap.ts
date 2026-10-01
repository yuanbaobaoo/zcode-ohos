import { app } from "electron";
import { applyEarlyChromiumHardwareAccelerationBootstrap } from "./desktopChromiumHardwareAccelerationBootstrap.js";
import { applyEarlyOhosRenderCompatBootstrap } from "./desktopOhosRenderCompatBootstrap.js";

applyEarlyChromiumHardwareAccelerationBootstrap(app);
applyEarlyOhosRenderCompatBootstrap();
