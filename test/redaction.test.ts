import { describe, expect, it } from "vitest";

import { redact } from "../src/redaction.js";

describe("redact", () => {
  it("설정 형태의 비밀값을 제거한다", () => {
    const secret = "super-secret-value";
    const result = redact(`API_KEY=${secret} password: hunter2`);

    expect(result.text).toBe("API_KEY=[REDACTED] password: [REDACTED]");
    expect(result.text).not.toContain(secret);
    expect(result.text).not.toContain("hunter2");
    expect(result.count).toBe(2);
  });

  it("private key 블록 전체를 제거한다", () => {
    const result = redact(`before
-----BEGIN PRIVATE KEY-----
secret-material
-----END PRIVATE KEY-----
after`);

    expect(result.text).toBe("before\n[REDACTED]\nafter");
    expect(result.count).toBe(1);
  });

  it("연결 URL의 비밀번호를 제거한다", () => {
    const result = redact("postgresql://alice:secret@db.example.com/app");

    expect(result.text).toBe("postgresql://alice:[REDACTED]@db.example.com/app");
    expect(result.count).toBe(1);
  });

  it("일반 텍스트는 변경하지 않는다", () => {
    const input = "결제 브랜치에서 재시도 정책을 결정했다.";
    expect(redact(input)).toEqual({ text: input, count: 0 });
  });
});
