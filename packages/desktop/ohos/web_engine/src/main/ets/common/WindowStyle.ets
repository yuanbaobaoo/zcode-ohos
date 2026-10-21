import LogUtil from '../utils/LogUtil';
import LogMethod from './LogDecorator';

export interface IStyleData {
  backgroundColor: string,
  opacity: number
};

export interface IUpdateStyle {
  registerUpdateStyleFunction: Function,
  removeUpdateStyleFunction: Function
};

export class WindowStyle {
  private static TAG: string = '[WindowStyle]';
  private static styleDataMap: Map<string, IStyleData> = new Map();
  private static updateStyleFuncMap: Map<string, (style: IStyleData) => void> = new Map();

  @LogMethod
  static registerUpdateStyleFunction(
    id: string, initStyle: IStyleData,
    func: (style: IStyleData) => void): void {
    LogUtil.info(WindowStyle.TAG, 'registerUpdateStyleFunction ' + id);
    const key = WindowStyle.idNormalization(id);
    const styleData = WindowStyle.styleDataMap.get(key) ?? initStyle;
    WindowStyle.updateStyleFuncMap.set(key, func);
    WindowStyle.styleDataMap.set(key, styleData);
    func(styleData);
  }

  @LogMethod
  static removeUpdateStyleFunction(id: string): void {
    LogUtil.info(WindowStyle.TAG, 'removeUpdateStyleFunction ' + id);
    const key = WindowStyle.idNormalization(id);
    WindowStyle.updateStyleFuncMap.delete(key);
    WindowStyle.styleDataMap.delete(key);
  }

  private static idNormalization(id: string | number): string {
    return typeof id === 'number' ? 'browser' + id : id.toString();
  }

  static getUpdateStyleFunc(id: string | number): Function | undefined {
    return WindowStyle.updateStyleFuncMap.get(WindowStyle.idNormalization(id));
  }

  @LogMethod
  static getStyleData(id: string | number): IStyleData | undefined {
    return WindowStyle.styleDataMap.get(WindowStyle.idNormalization(id));
  }

  @LogMethod
  static updateStyleData(id: string | number, styleData: IStyleData): void {
    WindowStyle.styleDataMap.set(WindowStyle.idNormalization(id), styleData);
  }

  @LogMethod
  static decimalColorToHex(decimalColor: number): string {
    return decimalColor.toString(16).padStart(8, '0');
  }

  @LogMethod
  static hexColorToDecimal(hexColor: string): number {
    return parseInt(hexColor, 16);
  }

  @LogMethod
  static getColorAlpha(decimalColor: number): number {
    return (decimalColor >>> 24) / 255;
  }

  @LogMethod
  static decimalOpacityToHex(decimalOpacity: number): string {
    return Math.round(decimalOpacity * 255).toString(16).padStart(2, '0');
  }
};
