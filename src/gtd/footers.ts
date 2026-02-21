export const FOOTER_MARKER = "JD-BOT (do not edit below)";

export type FooterData = {
  type: "action" | "project" | "reference" | "someday";
  board: "growth" | "embxr" | "bdxr";
  list:
    | "actionItems"
    | "inProgress"
    | "projects"
    | "doneWeekly"
    | "reference"
    | "maybeSomeday"
    | "processing"
    | "waitingFor";
  links?: {
    projectCardUrl?: string;
    actionCardUrl?: string;
  };
  slack?: {
    user?: string;
    channel?: string;
    ts?: string;
  };
  log?: string[];
  total_hours?: number;
};

export function buildFooter(data: FooterData): string {
  const lines: string[] = [];
  lines.push(`type: ${data.type}`);
  lines.push(`board: ${data.board}`);
  lines.push(`list: ${data.list}`);

  if (data.links?.projectCardUrl || data.links?.actionCardUrl) {
    lines.push("links:");
    if (data.links.projectCardUrl) {
      lines.push(`  projectCardUrl: ${data.links.projectCardUrl}`);
    }
    if (data.links.actionCardUrl) {
      lines.push(`  actionCardUrl: ${data.links.actionCardUrl}`);
    }
  }

  if (data.slack?.user || data.slack?.channel || data.slack?.ts) {
    lines.push("slack:");
    if (data.slack.user) {
      lines.push(`  user: ${data.slack.user}`);
    }
    if (data.slack.channel) {
      lines.push(`  channel: ${data.slack.channel}`);
    }
    if (data.slack.ts) {
      lines.push(`  ts: ${data.slack.ts}`);
    }
  }

  if (data.log && data.log.length > 0) {
    lines.push("log:");
    for (const entry of data.log) {
      lines.push(`  - ${entry}`);
    }
  }

  if (data.total_hours !== undefined) {
    lines.push(`total_hours: ${data.total_hours}`);
  }

  return lines.join("\n");
}

export function parseFooter(desc: string): FooterData | null {
  const markerIndex = desc.indexOf(FOOTER_MARKER);
  if (markerIndex < 0) {
    return null;
  }

  const footerText = desc.slice(markerIndex + FOOTER_MARKER.length).trim();
  if (!footerText) {
    return null;
  }

  const lines = footerText.split(/\r?\n/);
  const data: Partial<FooterData> = {};
  let section: "links" | "slack" | "log" | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    if (trimmed === "links:") {
      section = "links";
      data.links = data.links ?? {};
      continue;
    }
    if (trimmed === "slack:") {
      section = "slack";
      data.slack = data.slack ?? {};
      continue;
    }
    if (trimmed === "log:") {
      section = "log";
      data.log = data.log ?? [];
      continue;
    }

    if (trimmed.startsWith("type:")) {
      data.type = trimmed.replace("type:", "").trim() as FooterData["type"];
      section = null;
      continue;
    }
    if (trimmed.startsWith("board:")) {
      data.board = trimmed.replace("board:", "").trim() as FooterData["board"];
      section = null;
      continue;
    }
    if (trimmed.startsWith("list:")) {
      data.list = trimmed.replace("list:", "").trim() as FooterData["list"];
      section = null;
      continue;
    }
    if (trimmed.startsWith("total_hours:")) {
      const value = trimmed.replace("total_hours:", "").trim();
      const parsed = Number(value);
      if (!Number.isNaN(parsed)) {
        data.total_hours = parsed;
      }
      section = null;
      continue;
    }

    if (section === "links" && line.startsWith("  ")) {
      const [key, ...rest] = trimmed.split(":");
      const value = rest.join(":").trim();
      data.links = data.links ?? {};
      if (key === "projectCardUrl") {
        data.links.projectCardUrl = value;
      }
      if (key === "actionCardUrl") {
        data.links.actionCardUrl = value;
      }
      continue;
    }

    if (section === "slack" && line.startsWith("  ")) {
      const [key, ...rest] = trimmed.split(":");
      const value = rest.join(":").trim();
      data.slack = data.slack ?? {};
      if (key === "user") {
        data.slack.user = value;
      }
      if (key === "channel") {
        data.slack.channel = value;
      }
      if (key === "ts") {
        data.slack.ts = value;
      }
      continue;
    }

    if (section === "log" && trimmed.startsWith("- ")) {
      data.log = data.log ?? [];
      data.log.push(trimmed.replace("- ", ""));
      continue;
    }
  }

  if (!data.type || !data.board || !data.list) {
    return null;
  }

  return data as FooterData;
}
export function appendOrReplaceFooter(
  existingDesc: string,
  footer: string
): string {
  const markerIndex = existingDesc.indexOf(FOOTER_MARKER);
  if (markerIndex >= 0) {
    const trimmed = existingDesc.slice(0, markerIndex).trimEnd();
    return `${trimmed}\n\n---\n${FOOTER_MARKER}\n${footer}`;
  }

  const prefix = existingDesc.trimEnd();
  const base = prefix.length > 0 ? `${prefix}\n\n` : "";
  return `${base}---\n${FOOTER_MARKER}\n${footer}`;
}

export function appendLogLine(desc: string, line: string): string {
  const markerIndex = desc.indexOf(FOOTER_MARKER);
  if (markerIndex < 0) {
    const footer = buildFooter({
      type: "action",
      board: "growth",
      list: "actionItems",
      log: [line],
    });
    return appendOrReplaceFooter(desc, footer);
  }

  const headerEnd = markerIndex + FOOTER_MARKER.length;
  const afterMarker = desc.slice(headerEnd).replace(/^\s*\n?/, "");
  const footerBody = afterMarker.trimEnd();

  if (footerBody.includes("\nlog:\n") || footerBody.startsWith("log:\n")) {
    const updatedFooter = `${footerBody}\n  - ${line}`;
    return appendOrReplaceFooter(desc, updatedFooter);
  }

  const updatedFooter = `${footerBody}\nlog:\n  - ${line}`.trim();
  return appendOrReplaceFooter(desc, updatedFooter);
}
