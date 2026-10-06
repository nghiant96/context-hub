import { test } from "node:test";
import assert from "node:assert/strict";
import { foldVietnamese, redact, toFtsQuery, truncate } from "../src/text.ts";
import { extractIssueKeys, isFixSubject, mergedBranch } from "../src/sources/git.ts";
import { normalizeJiraBaseUrl } from "../src/config.ts";

test("normalizeJiraBaseUrl accepts the address people copy from the browser", () => {
  assert.equal(normalizeJiraBaseUrl("https://onemount.atlassian.net/jira"), "https://onemount.atlassian.net");
  assert.equal(normalizeJiraBaseUrl("https://onemount.atlassian.net/browse/HOS-1313/"), "https://onemount.atlassian.net");
  assert.equal(normalizeJiraBaseUrl(" https://onemount.atlassian.net "), "https://onemount.atlassian.net");
  assert.equal(normalizeJiraBaseUrl("https://jira.internal.example/jira/"), "https://jira.internal.example/jira");
  assert.equal(normalizeJiraBaseUrl(""), "");
});

test("foldVietnamese strips diacritics, including đ", () => {
  assert.equal(foldVietnamese("Đường phố Hà Nội — Thiết lập mã PIN"), "duong pho ha noi — thiet lap ma pin");
});

test("toFtsQuery quotes every word so user input cannot break FTS syntax", () => {
  assert.equal(toFtsQuery('Quên mã "PIN" (OTP)'), '"quen"* "ma"* "pin"* "otp"*');
  assert.equal(toFtsQuery("mã pin", "any"), '"ma"* OR "pin"*');
  assert.equal(toFtsQuery("  ** ()  "), "");
});

test("redact masks personal data that health tickets may carry", () => {
  const text = "BN Nguyễn A, sđt 0912 345 678, +84987654321, CCCD 001099012345, CMND 123456789, mail a.b@benhvien.vn";
  const result = redact(text);
  for (const leaked of ["0912 345 678", "+84987654321", "001099012345", "123456789", "a.b@benhvien.vn"]) {
    assert.ok(!result.includes(leaked), `${leaked} should be redacted: ${result}`);
  }
  assert.match(result, /\[phone\].*\[phone\].*\[id-number\].*\[id-number\].*\[email\]/);
  // Ticket keys, versions and short numbers are left alone.
  assert.equal(redact("HOS-1313 nâng SDK lên 0.5.3, sai 5 lần"), "HOS-1313 nâng SDK lên 0.5.3, sai 5 lần");
});

test("truncate marks the cut", () => {
  assert.equal(truncate("abcdef", 3), "abc …");
  assert.equal(truncate("abc", 3), "abc");
});

test("extractIssueKeys reads commit and branch naming conventions", () => {
  assert.deepEqual(extractIssueKeys("HOS-1313 fix: OTP", ["HOS"]), ["HOS-1313"]);
  assert.deepEqual(extractIssueKeys("Merge branch 'qc/HOS-1310-1456-1471-1313' into develop", ["HOS"]), ["HOS-1310", "HOS-1456", "HOS-1471", "HOS-1313"]);
  assert.deepEqual(extractIssueKeys("Merge branch 'feature/HOS-1313-thiet-lap-ma-pin-biometric'", ["HOS"]), ["HOS-1313"]);
  assert.deepEqual(extractIssueKeys("HOS-003 fix: cache hồ sơ", ["HOS"]), ["HOS-3"]);
  assert.deepEqual(extractIssueKeys("bump UTF-8 handling, see ABC-12", ["HOS"]), []);
});

test("mergedBranch reads the source branch, never the target", () => {
  assert.equal(mergedBranch("Merge branch 'feature/HOS-1024' into 'develop'"), "feature/HOS-1024");
  assert.equal(mergedBranch("Merge branch 'develop' into HOS-588/health-score-category-menu"), "develop");
  assert.equal(mergedBranch("Merge remote-tracking branch 'origin/qc/HOS-1310-1456'"), "origin/qc/HOS-1310-1456");
  assert.equal(mergedBranch("Merge pull request #12 from team/feature/HOS-7-otp"), "team/feature/HOS-7-otp");
  assert.equal(mergedBranch("HOS-910 merge(develop): hợp nhất HealthPlanService"), null);
});

test("isFixSubject reads the change type, not every mention of fix", () => {
  const fixes = [
    "HOS-12 fix: OTP hết hạn vẫn cho nhập",
    "fix(auth): refresh token",
    "HOS-1158 fixbug ui booking listing",
    "HOS-981 Fix text",
    "feat(HOS-982): fix bugs",
    "HOS-947 bug UI confirm booking",
    "HOS-1474 sửa map sinh trắc yếu",
    "[HOS-5] hotfix: crash khi mở app",
    "hos-001: Fixed crash"
  ];
  const others = [
    "HOS-1183 refactor: replace shellStyle to fix double border rendering",
    "HOS-970 test: fix flaky tests by using waitFor",
    "HOS-90 test(adaptive-card): ghim Date.now cua fixture BFF",
    "HOS-1235 docs: sửa tham chiếu file trong README",
    "feat(HOS-643): update asset wiki, fix bug input in profile",
    "HOS-1 fixture: thêm dữ liệu mẫu",
    "HOS-366 add debug auth flow entrypoints",
    "Revert \"HOS-12 fix: OTP\""
  ];
  assert.deepEqual(fixes.filter((subject) => !isFixSubject(subject)), []);
  assert.deepEqual(others.filter(isFixSubject), []);
});
