import { join } from "node:path";
import { test, expect } from "vitest";
import { getDataBaseDir, getZCodeDataRootDir } from "../src/paths.js";

test("ZCODE_DATA_ROOT_DIR 绝对路径覆盖数据根（开发包，spec 24）", () => {
  const saved = process.env.ZCODE_DATA_ROOT_DIR;
  try {
    process.env.ZCODE_DATA_ROOT_DIR = "/storage/Users/currentUser/.zcode-dev";
    expect(getZCodeDataRootDir()).toBe("/storage/Users/currentUser/.zcode-dev");
  } finally {
    if (saved === undefined) delete process.env.ZCODE_DATA_ROOT_DIR;
    else process.env.ZCODE_DATA_ROOT_DIR = saved;
  }
});

test("相对路径与空值不覆盖，回落 {dataBaseDir}/.zcode", () => {
  const saved = process.env.ZCODE_DATA_ROOT_DIR;
  try {
    for (const value of ["relative/.zcode-dev", "  "]) {
      process.env.ZCODE_DATA_ROOT_DIR = value;
      expect(getZCodeDataRootDir()).toBe(join(getDataBaseDir(), ".zcode"));
    }
  } finally {
    if (saved === undefined) delete process.env.ZCODE_DATA_ROOT_DIR;
    else process.env.ZCODE_DATA_ROOT_DIR = saved;
  }
});
