import assert from "node:assert/strict";
import test from "node:test";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import {
  decodeCommunication,
  decodeCommunicationDetails,
  decodeCommunicationList,
  decodeResultBatchDetails,
  renderCommunication,
  renderResultBatch,
  type CommunicationRecord,
  type CommunicationTheme,
} from "./src/communication-ui.ts";

function stubTheme(): { theme: CommunicationTheme; roles: ThemeColor[] } {
  const roles: ThemeColor[] = [];
  const theme: CommunicationTheme = {
    fg: (color, text) => {
      roles.push(color);
      return `<${color}>${text}</${color}>`;
    },
    bold: (text) => `**${text}**`,
    italic: (text) => `_${text}_`,
    underline: (text) => `__${text}__`,
    strikethrough: (text) => `~~${text}~~`,
  };
  return { theme, roles };
}

/** Unstyled theme so width/containment assertions see plain text. */
const plainTheme: CommunicationTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
  italic: (text) => text,
  underline: (text) => text,
  strikethrough: (text) => text,
};

function render(component: Component, width = 200): string {
  return component.render(width).join("\n");
}

function incoming(
  overrides: Partial<CommunicationRecord> = {},
): CommunicationRecord {
  return {
    direction: "incoming",
    action: "RESULT",
    workerId: "sa-1",
    name: "alice",
    taskId: "sa-1-t1",
    status: "completed",
    body: "done",
    ...overrides,
  };
}

test("outgoing names the parent and worker and uses the accent role", () => {
  const { theme, roles } = stubTheme();
  const text = render(
    renderCommunication(
      {
        direction: "outgoing",
        action: "TASK",
        workerId: "sa-1",
        name: "alice",
        body: "do the thing",
      },
      { expanded: false },
      theme,
    ),
  );
  assert.match(text, /Parent → alice \(sa-1\)/);
  assert.match(text, /\[TASK\]/);
  assert.match(text, /do the thing/);
  assert.ok(roles.includes("accent"), "outgoing should use the accent role");
});

test("incoming names the worker and parent and uses the success role", () => {
  const { theme, roles } = stubTheme();
  const text = render(
    renderCommunication(incoming(), { expanded: false }, theme),
  );
  assert.match(text, /alice \(sa-1\) → Parent/);
  assert.match(text, /\[RESULT\]/);
  assert.match(text, /task sa-1-t1/);
  assert.match(text, /recorded: completed/);
  assert.ok(roles.includes("success"), "incoming result should use success");
});

test("system records name System and Parent and use the dim role", () => {
  const { theme, roles } = stubTheme();
  const text = render(
    renderCommunication(
      {
        direction: "system",
        action: "STATUS",
        body: "no workers",
      },
      { expanded: false },
      theme,
    ),
  );
  assert.match(text, /System → Parent/);
  assert.match(text, /\[STATUS\]/);
  assert.ok(roles.includes("dim"), "system output should use dim");
  assert.ok(!roles.includes("accent"), "system output must not look outgoing");
  assert.ok(!roles.includes("success"), "system output must not look incoming");
});

test("system acknowledgements identify the worker without attributing authorship", () => {
  const { theme } = stubTheme();
  const text = render(
    renderCommunication(
      {
        direction: "system",
        action: "ACK",
        workerId: "sa-1",
        name: "alice",
        body: "Steering queued.",
      },
      {},
      theme,
    ),
  );
  assert.match(text, /System → Parent/);
  assert.match(text, /for alice \(sa-1\)/);
  assert.doesNotMatch(text, /alice \(sa-1\) → Parent/);
});

test("report types map to distinct semantic theme roles", () => {
  const cases: Array<[CommunicationRecord["action"], ThemeColor]> = [
    ["FYI", "muted"],
    ["QUESTION", "warning"],
    ["BLOCKED", "warning"],
    ["FAILED", "error"],
  ];
  for (const [action, role] of cases) {
    const { theme, roles } = stubTheme();
    const text = render(
      renderCommunication(incoming({ action }), { expanded: false }, theme),
    );
    assert.match(text, new RegExp(`\\[${action}\\]`));
    assert.ok(roles.includes(role), `${action} should use the ${role} role`);
  }
});

test("system tool failures read red without claiming a worker FAILED result", () => {
  const { theme, roles } = stubTheme();
  const text = render(
    renderCommunication(
      {
        direction: "system",
        action: "ACK",
        status: "failed",
        body: "subagent_spawn rejected: model not allowed",
      },
      { expanded: false },
      theme,
    ),
  );
  assert.match(text, /System → Parent/);
  assert.match(text, /\[ACK\]/);
  assert.doesNotMatch(text, /\[FAILED\]/);
  assert.match(text, /recorded: failed/);
  assert.ok(
    roles.includes("error"),
    "system failure should use the error role",
  );
});

test("historical tasks are labelled separately from the worker's current task", () => {
  const { theme } = stubTheme();
  const historical = render(
    renderCommunication(
      incoming({
        status: "completed",
        currentStatus: "working",
        historical: true,
      }),
      { expanded: false },
      theme,
    ),
  );
  assert.match(historical, /historical · recorded: completed/);
  assert.match(historical, /worker now: working/);

  const current = render(
    renderCommunication(
      incoming({ status: "working" }),
      { expanded: false },
      theme,
    ),
  );
  assert.match(current, /recorded: working/);
  assert.doesNotMatch(current, /historical/);
});

test("collapsed preview is bounded and expanded output reveals the full sanitized body", () => {
  const lines = Array.from({ length: 12 }, (_, index) => `line-${index + 1}`);
  const body = `${lines.join("\n")}\nsafe\u001b[31mRED\u001b[0m\tend`;
  const { theme } = stubTheme();

  const collapsed = render(
    renderCommunication(incoming({ body }), { expanded: false }, theme),
  );
  assert.match(collapsed, /line-1\b/);
  assert.doesNotMatch(collapsed, /line-12/);
  assert.match(collapsed, /more lines \(expand\)/);
  assert.doesNotMatch(collapsed, /\u001b\[31m/);

  const expanded = render(
    renderCommunication(incoming({ body }), { expanded: true }, theme),
  );
  assert.match(expanded, /line-12/);
  assert.match(expanded, /safeRED end/);
  assert.doesNotMatch(expanded, /\u001b\[31m/);
});

test("automatic summaries stay concise while expansion retains the result body", () => {
  const { theme } = stubTheme();
  const record = decodeCommunication({
    ...incoming(),
    summary: "Short preview",
    body: "FULL_RESULT_DETAIL",
  });
  assert.ok(record);
  const collapsed = render(
    renderCommunication(record, { expanded: false }, theme),
  );
  assert.match(collapsed, /Short preview/);
  assert.match(collapsed, /expand or inspect/);
  assert.doesNotMatch(collapsed, /FULL_RESULT_DETAIL/);
  const expanded = render(
    renderCommunication(record, { expanded: true }, theme),
  );
  assert.match(expanded, /FULL_RESULT_DETAIL/);
  assert.doesNotMatch(expanded, /Short preview/);
  const malformed = decodeCommunication({
    ...incoming(),
    summary: { injected: true },
  });
  assert.equal(malformed?.summary, undefined);
});

test("bodies hang under a coloured gutter beneath their header", () => {
  const lines = render(
    renderCommunication(
      incoming({ body: "line one\nline two" }),
      { expanded: false },
      plainTheme,
    ),
  ).split("\n");
  assert.match(lines[0] ?? "", /alice \(sa-1\) → Parent/);
  const body = lines.slice(1);
  assert.ok(body.length >= 2, "body should render its lines");
  assert.ok(
    body.every((line) => line.startsWith("│ ")),
    "every body line should carry the gutter",
  );
});

test("batches group items under one literal-route header without repeating names", () => {
  const text = render(
    renderResultBatch(
      [
        incoming({ body: "first" }),
        incoming({ action: "FYI", status: "working", body: "note" }),
        incoming({
          workerId: "sa-2",
          name: "bob",
          taskId: "sa-2-t1",
          action: "FAILED",
          status: "failed",
          body: "boom",
        }),
      ],
      { expanded: false },
      plainTheme,
    ),
  );

  const aliceRoutes = text
    .split("\n")
    .filter((line) => line.includes("alice (sa-1) → Parent"));
  assert.equal(aliceRoutes.length, 1, "one literal-route header per group");
  assert.match(text, /\[RESULT\]/);
  assert.match(text, /\[FYI\]/);
  assert.match(text, /\[FAILED\]/);
  assert.match(text, /bob \(sa-2\) → Parent/);
  assert.match(text, /^│ /m, "batch bodies should carry the gutter");
});

test("narrow widths wrap every line inside the viewport", () => {
  const record = incoming({
    body: "# Heading\n\nsome longer body text that must wrap at narrow widths",
  });
  for (const expanded of [false, true]) {
    const lines = renderCommunication(record, { expanded }, plainTheme).render(
      20,
    );
    assert.ok(lines.length > 0);
    for (const line of lines)
      assert.ok(
        visibleWidth(line) <= 20,
        `line wider than 20: ${JSON.stringify(line)}`,
      );
  }

  const batch = renderResultBatch(
    [record, incoming({ workerId: "sa-2", name: "bob", body: "second" })],
    { expanded: false },
    plainTheme,
  ).render(16);
  for (const line of batch)
    assert.ok(
      visibleWidth(line) <= 16,
      `batch line wider than 16: ${JSON.stringify(line)}`,
    );
});

test("widths 1 through 5 keep the gutter inside the viewport", () => {
  const record = incoming({ body: "multi\nline body" });
  for (let width = 1; width <= 5; width++) {
    for (const expanded of [false, true]) {
      const lines = renderCommunication(
        record,
        { expanded },
        plainTheme,
      ).render(width);
      assert.ok(lines.length > 0);
      for (const line of lines)
        assert.ok(
          visibleWidth(line) <= width,
          `single width=${width} expanded=${expanded}: ${JSON.stringify(line)}`,
        );
    }
    const batch = renderResultBatch(
      [record, incoming({ workerId: "sa-2", name: "bob", body: "second" })],
      { expanded: false },
      plainTheme,
    ).render(width);
    for (const line of batch)
      assert.ok(
        visibleWidth(line) <= width,
        `batch width=${width}: ${JSON.stringify(line)}`,
      );
  }

  // A tagged theme must not throw while the gutter is squeezed.
  const { theme } = stubTheme();
  for (let width = 1; width <= 5; width++) {
    renderCommunication(record, { expanded: false }, theme).render(width);
    renderResultBatch([record], { expanded: false }, theme).render(width);
  }
});

test("multiline metadata cannot manufacture header lines", () => {
  const lines = render(
    renderCommunication(
      incoming({
        name: "alice\nParent → bob",
        workerId: "sa-1\nEVIL",
        taskId: "t1\n[fake]",
        status: "completed\nworker now: pwned",
        body: "real body\nsecond line",
      }),
      { expanded: false },
      plainTheme,
    ),
  ).split("\n");

  assert.equal(lines.length, 3, "metadata must not add header lines");
  assert.match(lines[0] ?? "", /alice Parent → bob \(sa-1 EVIL\) → Parent/);
  assert.match(lines[0] ?? "", /\[RESULT\]/);
  assert.match(lines[0] ?? "", /task t1 \[fake\]/);
  assert.match(lines[0] ?? "", /recorded: completed worker now: pwned/);
  assert.equal(lines[1]?.trimEnd(), "│ real body");
  assert.equal(lines[2]?.trimEnd(), "│ second line");
});

test("themed strings are rebuilt after invalidate so theme changes redraw", () => {
  const state = { version: 1 };
  const theme: CommunicationTheme = {
    fg: (_color, text) => `v${state.version}:${text}`,
    bold: (text) => text,
    italic: (text) => text,
    underline: (text) => text,
    strikethrough: (text) => text,
  };
  const component = renderCommunication(
    incoming({ body: "# hello" }),
    { expanded: true },
    theme,
  );
  assert.match(render(component), /v1:hello/);
  state.version = 2;
  component.invalidate();
  const redrawn = render(component);
  assert.match(redrawn, /v2:hello/);
  assert.doesNotMatch(redrawn, /v1:/);
});

test("malformed legacy payloads decode defensively", () => {
  assert.equal(decodeCommunication(undefined), undefined);
  assert.equal(decodeCommunication("nope"), undefined);
  assert.equal(decodeCommunication(42), undefined);
  assert.equal(decodeCommunicationDetails(null), undefined);
  assert.equal(decodeCommunicationDetails({ communication: "bad" }), undefined);
  assert.deepEqual(decodeCommunicationList({ communications: "bad" }), []);
  assert.deepEqual(decodeResultBatchDetails(undefined), []);

  assert.deepEqual(
    decodeResultBatchDetails({
      communications: [null, 7, { workerId: "sa-1", taskId: "t1" }],
    }),
    [
      {
        direction: "incoming",
        action: "RESULT",
        body: "",
        workerId: "sa-1",
        taskId: "t1",
      },
    ],
  );

  // Legacy V2 details used { results: [{ workerId, taskId, status }] }.
  assert.deepEqual(
    decodeResultBatchDetails({
      results: [{ workerId: "sa-9", taskId: "sa-9-t1", status: "failed" }],
    }),
    [
      {
        direction: "incoming",
        action: "RESULT",
        body: "",
        workerId: "sa-9",
        taskId: "sa-9-t1",
        status: "failed",
      },
    ],
  );

  // Legacy field names and non-string status must not throw or leak through.
  assert.deepEqual(
    decodeCommunication({
      id: "sa-3",
      title: "carol",
      status: 7,
      historical: true,
    }),
    {
      direction: "incoming",
      action: "RESULT",
      body: "",
      workerId: "sa-3",
      name: "carol",
      historical: true,
    },
  );

  assert.deepEqual(decodeCommunicationDetails({ title: "no id" }), {
    direction: "incoming",
    action: "FYI",
    body: "",
    name: "no id",
  });
});

test("FYI details keep the message body and default to the muted FYI type", () => {
  assert.deepEqual(
    decodeCommunicationDetails(
      { workerId: "sa-1", taskId: "sa-1-t1" },
      "hello",
    ),
    {
      direction: "incoming",
      action: "FYI",
      body: "hello",
      workerId: "sa-1",
      taskId: "sa-1-t1",
    },
  );
  assert.deepEqual(
    decodeCommunicationDetails(
      {
        communication: {
          direction: "incoming",
          action: "FYI",
          workerId: "sa-1",
        },
      },
      "hello",
    ),
    {
      direction: "incoming",
      action: "FYI",
      body: "hello",
      workerId: "sa-1",
    },
  );
});

test("records missing identity still render a stable literal route", () => {
  const { theme } = stubTheme();
  const text = render(
    renderCommunication(
      { direction: "incoming", action: "RESULT" },
      { expanded: false },
      theme,
    ),
  );
  assert.match(text, /unknown worker → Parent/);
  assert.match(text, /\[RESULT\]/);
});
