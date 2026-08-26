import { describe, expect, it, vi } from "vitest";

import { type PackageUpdateRunner, updateGlobalPackage } from "../src/package-update.js";

const OPTIONS = {
  name: "agents-memory",
  version: "0.1.1",
  nodePath: "/usr/local/bin/node",
};

function result(stdout = "", stderr = "", status = 0) {
  return { status, stdout, stderr };
}

describe("updateGlobalPackage", () => {
  it("최신 버전을 온라인으로 확인하고 전역 패키지와 클라이언트 설정을 갱신한다", () => {
    const runner = vi
      .fn<PackageUpdateRunner>()
      .mockReturnValueOnce(result("0.2.0\n"))
      .mockReturnValueOnce(result())
      .mockReturnValueOnce(result("/usr/local/lib/node_modules\n"))
      .mockReturnValueOnce(result("0.2.0\n"))
      .mockReturnValueOnce(result('{"daemon":{"status":"configured"},"clients":[]}\n'));

    expect(updateGlobalPackage(OPTIONS, runner)).toEqual({
      status: "updated",
      previousVersion: "0.1.1",
      version: "0.2.0",
      setup: { daemon: { status: "configured" }, clients: [] },
    });
    expect(runner).toHaveBeenNthCalledWith(1, "npm", [
      "view",
      "agents-memory@latest",
      "version",
      "--prefer-online",
    ]);
    expect(runner).toHaveBeenNthCalledWith(2, "npm", [
      "install",
      "--global",
      "agents-memory@latest",
      "--prefer-online",
    ]);
    expect(runner).toHaveBeenNthCalledWith(3, "npm", ["root", "--global"]);
    expect(runner).toHaveBeenNthCalledWith(4, OPTIONS.nodePath, [
      "/usr/local/lib/node_modules/agents-memory/dist/cli.js",
      "--version",
    ]);
    expect(runner).toHaveBeenNthCalledWith(5, OPTIONS.nodePath, [
      "/usr/local/lib/node_modules/agents-memory/dist/cli.js",
      "setup",
      "all",
    ]);
  });

  it("이미 최신 버전이면 패키지를 다시 설치하지 않는다", () => {
    const runner = vi.fn<PackageUpdateRunner>().mockReturnValue(result("0.1.1\n"));

    expect(updateGlobalPackage(OPTIONS, runner)).toEqual({
      status: "up-to-date",
      previousVersion: "0.1.1",
      version: "0.1.1",
    });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("설치 결과가 latest와 다르면 설정을 갱신하지 않는다", () => {
    const runner = vi
      .fn<PackageUpdateRunner>()
      .mockReturnValueOnce(result("0.2.0\n"))
      .mockReturnValueOnce(result())
      .mockReturnValueOnce(result("/usr/local/lib/node_modules\n"))
      .mockReturnValueOnce(result("0.1.1\n"));

    expect(() => updateGlobalPackage(OPTIONS, runner)).toThrow(
      "The installed package version is 0.1.1, but NPM latest is 0.2.0.",
    );
    expect(runner).toHaveBeenCalledTimes(4);
  });

  it("npm 오류 내용을 보존한다", () => {
    const runner = vi
      .fn<PackageUpdateRunner>()
      .mockReturnValue(result("", "network unavailable\n", 1));

    expect(() => updateGlobalPackage(OPTIONS, runner)).toThrow(
      "Unable to check the latest NPM version: network unavailable",
    );
  });
});
