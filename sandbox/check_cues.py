#!/usr/bin/env python3
"""Checks the Apprentice KB against the sandbox pages.

1. every cue / requires string in kb/<id>/rules.json appears literally (case-insensitive)
   in the rendered text of <id>.html (the page text, not CSS/JS);
2. rule schema: required keys, kind, 6-9 rules, >= 2 guardrails, question <= 20 words,
   warning <= 25 words, index.json matches the directories, profile.md 40-80 lines;
3. case matrix: for each sandbox case, which rules fire (any cue AND all requires, on the text
   visible in that case) must equal the expected set below.

Usage: python3 check_cues.py            (exit code 0 = all good)
"""
import json, os, re, sys
from html.parser import HTMLParser

HERE = os.path.dirname(os.path.abspath(__file__))
KB = os.path.join(HERE, "..", "mac", "Resources", "kb")

# (case id, overrides for selects, expected rule ids that fire on that screen)
EXPECTED = {
    "programmer": [
        ("list", {}, []),
        ("e1", {}, ["flaky-e2e"]),
        ("e2", {}, ["postinstall-dependency"]),
        ("e3", {}, ["green-read-the-diff"]),
        ("nv", {}, ["weakened-test"]),
        ("x1", {}, ["fork-no-secrets"]),
        ("x2", {}, ["workflow-edit"]),
        ("x3", {}, ["security-hotfix"]),
        ("x4", {}, ["cla-typo-fix"]),
        ("x5", {}, ["snapshot-intentional"]),
    ],
    "accountant": [
        ("list", {}, []),
        ("e1", {}, ["equipment-not-opex"]),                                   # before the expert re-codes
        ("e1", {"cc-e1": "0400"}, ["capex-over-5000", "no-asset-no-capex"]),  # after re-coding to capex
        ("e2", {}, ["december-duplicate-hold"]),
        ("e3", {}, ["czech-second-approval"]),
        ("nv", {}, ["equipment-not-opex"]),                                   # novice reaches for opex
        ("nv", {"cc-nv": "0400"}, ["capex-over-5000", "no-asset-no-capex"]),
        ("x1", {}, ["unknown-supplier-stop"]),
    ],
    "support": [
        ("s1", {}, ["window-closed-incident"]),
        ("s2", {}, ["chargeback-no-refund"]),
        ("s3", {}, ["enterprise-account-manager"]),
        ("nv", {}, ["window-closed-incident", "review-threat-not-reason"]),
        ("x1", {}, ["different-card-never"]),
        ("x2", {}, ["over-limit-second-approver"]),
    ],
}


class Extract(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.skip = 0
        self.section = None            # current case id or None (chrome)
        self.text = {None: []}         # section -> list of text chunks
        self.selects = {}              # select id -> [(value, text, selected)]
        self.cur_select = None
        self.cur_option = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in ("script", "style", "title"):
            self.skip += 1
        elif tag == "section" and (a.get("id") or "").startswith("case-"):
            self.section = a["id"][5:]
            self.text.setdefault(self.section, [])
        elif tag == "select":
            sid = a.get("id")
            if sid == "caseSel":
                self.skip += 1         # demo control bar: not part of any screen
                self.cur_select = "__ignore__"
            else:
                self.cur_select = sid
                self.selects[sid] = []
                self.text[self.section].append("\x00SEL:%s\x00" % sid)
        elif tag == "option" and self.cur_select not in (None, "__ignore__"):
            self.cur_option = [a.get("value"), "", "selected" in a]
            self.selects[self.cur_select].append(self.cur_option)

    def handle_endtag(self, tag):
        if tag in ("script", "style", "title"):
            self.skip -= 1
        elif tag == "section":
            self.section = None
        elif tag == "select":
            if self.cur_select == "__ignore__":
                self.skip -= 1
            self.cur_select = None
        elif tag == "option":
            self.cur_option = None

    def handle_data(self, data):
        if self.cur_option is not None and self.cur_select != "__ignore__":
            self.cur_option[1] += data
            return
        if self.skip or self.cur_select == "__ignore__":
            return
        self.text[self.section].append(data)


def norm(s):
    return re.sub(r"\s+", " ", s).strip().lower()


def screen_text(ex, case, overrides):
    parts = ex.text[None] + ex.text[case]
    s = " ".join(parts)

    def repl(m):
        sid = m.group(1)
        opts = ex.selects[sid]
        want = overrides.get(sid)
        for v, t, sel in opts:
            if (want is not None and v == want) or (want is None and sel):
                return " " + t + " "
        return " "
    return norm(re.sub("\x00SEL:(.*?)\x00", repl, s))


def all_page_text(ex, raw):
    chunks = []
    for k, v in ex.text.items():
        chunks.append(" ".join(v))
    for opts in ex.selects.values():
        chunks.extend(t for _, t, _ in opts)
    return norm(" ".join(chunks) + " " + raw)


def main():
    fails = 0

    def bad(msg):
        nonlocal fails
        fails += 1
        print("FAIL", msg)

    index = json.load(open(os.path.join(KB, "index.json"), encoding="utf-8"))
    ids = [e["id"] for e in index]
    for e in index:
        if set(e) != {"id", "name", "title"}:
            bad("index.json entry keys: %s" % e)
    for sid in EXPECTED:
        if sid not in ids:
            bad("index.json misses %s" % sid)

    for sid in EXPECTED:
        d = os.path.join(KB, sid)
        rules = json.load(open(os.path.join(d, "rules.json"), encoding="utf-8"))
        raw = open(os.path.join(HERE, sid + ".html"), encoding="utf-8").read()
        ex = Extract()
        ex.feed(raw)
        pagetxt = all_page_text(ex, "")
        n_cues = 0
        # schema
        keys = {"id", "title", "kind", "cues", "action_words", "question", "warning", "why", "source"}
        if not 6 <= len(rules) <= 9:
            bad("%s: %d rules (need 6-9)" % (sid, len(rules)))
        if sum(r["kind"] == "guardrail" for r in rules) < 2:
            bad("%s: fewer than 2 guardrails" % sid)
        if len({r["id"] for r in rules}) != len(rules):
            bad("%s: duplicate rule ids" % sid)
        for r in rules:
            miss = keys - set(r)
            extra = set(r) - keys - {"requires"}
            if miss or extra:
                bad("%s/%s keys missing=%s extra=%s" % (sid, r.get("id"), miss, extra))
            if r["kind"] not in ("why", "guardrail"):
                bad("%s/%s kind %r" % (sid, r["id"], r["kind"]))
            if r["source"] != "seed":
                bad("%s/%s source %r" % (sid, r["id"], r["source"]))
            if len(r["question"].split()) > 20:
                bad("%s/%s question %d words" % (sid, r["id"], len(r["question"].split())))
            if len(r["warning"].split()) > 25:
                bad("%s/%s warning %d words" % (sid, r["id"], len(r["warning"].split())))
            for c in r["cues"] + r.get("requires", []) + r["action_words"]:
                n_cues += 1
                if not c.strip() or norm(c) not in pagetxt:
                    bad("%s/%s string %r not found in %s.html" % (sid, r["id"], c, sid))
        # files
        pf = os.path.join(d, "profile.md")
        if not os.path.exists(pf):
            bad("%s/profile.md missing" % sid)
        else:
            n = len(open(pf, encoding="utf-8").read().splitlines())
            if not 40 <= n <= 80:
                bad("%s/profile.md has %d lines (need 40-80)" % (sid, n))
        df = os.path.join(d, "demo.md")
        if not os.path.exists(df) or not os.path.getsize(df):
            bad("%s/demo.md missing or empty" % sid)
        # matrix
        byid = {r["id"]: r for r in rules}
        for case, ov, expected in EXPECTED[sid]:
            if case not in ex.text:
                bad("%s: case %s missing in html" % (sid, case))
                continue
            t = screen_text(ex, case, ov)
            fired = []
            for r in rules:
                if any(norm(c) in t for c in r["cues"]) and all(norm(q) in t for q in r.get("requires", [])):
                    fired.append(r["id"])
            ok = sorted(fired) == sorted(expected)
            if not ok:
                bad("%s case %s %s fires %s, expected %s" % (sid, case, ov or "", fired, expected))
            else:
                print("  ok  %-10s %-4s %-18s -> %s" % (sid, case, ("cc=" + list(ov.values())[0]) if ov else "", ", ".join(fired) or "(nothing)"))
        print("%s: %d rules, %d strings checked against %s.html" % (sid, len(rules), n_cues, sid))

    print("RESULT:", "ALL PASSED" if not fails else "%d FAILURES" % fails)
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
