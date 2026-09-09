// Staging-only source transform for reviewed @dsh-external/dsh-webui@0.5.1.
// The caller owns package/archive qualification. Contracts: c389f96, alpha.2.
function region(source, marker, transform) {
  const start = source.indexOf(marker);
  const end = source.indexOf('//#endregion', start);
  if (start < 0 || end < start || source.indexOf(marker, start + marker.length) >= 0) {
    throw new Error(`Unknown WebUI input/chat/tool region: ${marker}`);
  }
  const original = source.slice(start, end);
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const updated = transform(original.replace(/\r\n/g, '\n'));
  if (updated.includes('.callView')) throw new Error(`Unknown reviewed WebUI callView usage: ${marker}`);
  return source.slice(0, start) + updated.replace(/\n/g, newline) + source.slice(end);
}

function replaceOnce(source, before, after) {
  const oldCount = source.split(before).length - 1;
  const newCount = source.split(after).length - 1;
  if (oldCount === 0 && newCount === 1) return source;
  if (oldCount !== 1 || source.replace(before, '').includes(after)) {
    throw new Error(`Unknown reviewed WebUI shape: ${before}`);
  }
  return source.replace(before, after);
}

export function migrateWebuiInputChatToolShapes(source) {
  let output = region(source, 'const BrowserSeat = ', block => {
    block = replaceOnce(block,
      'function BrowserSeat({ sessionId, input, inputActions }) {',
      'function BrowserSeat({ sessionId, useInput, inputActions }) {\n'
        + '\t\t\tconst input = useInput((snapshot) => snapshot);');
    if ((block.match(/input\.draft/g) || []).length !== 2) {
      throw new Error('Unknown reviewed BrowserSeat draft reads');
    }
    return block;
  });
  output = region(output, 'const UserRewindNodeView = ', block => {
    block = replaceOnce(block,
      'function UserRewindNodeView({ node, renderMessageImages, useSession, sessionId, sessions, workspaces, directory }) {',
      'function UserRewindNodeView({ node, renderMessageImages, useSession, useChat, sessionId, sessions, workspaces, directory }) {');
    return replaceOnce(block,
      'const prevTurnEnd = useSession((snapshot) => turnNumber === void 0 ? void 0 : snapshot.turnEnds.get(turnNumber - 1));',
      'const prevTurnEnd = useChat((snapshot) => turnNumber === void 0 ? void 0 : snapshot.legacy.turnEnds.get(turnNumber - 1));');
  });
  // alpha.2 ToolCallBlock carries raw call arguments/results, not presentation
  // cards. Like ui-tool's toolRowModel, classify from those authoritative fields.
  // Keep the reviewed badges, recursive rows, output, timing and drawer actions.
  output = region(output, 'function classifyActivity(block) {', block => replaceOnce(block,
    '\t\t\tconst view = block.callView;\n'
      + '\t\t\tif (view !== null && view.card === "terminal") return "command";\n'
      + '\t\t\tif (view !== null && view.card === "generic" && view.kind === "execute") return "command";\n'
      + '\t\t\tif (/^(bash|sh|pwsh|powershell|cmd|zsh)$/i.test(name)) return "command";',
    '\t\t\tif (/^(bash|sh|pwsh|powershell|cmd|zsh)$/i.test(name)) return "command";'));
  output = region(output, 'function commandText(block) {', block => {
    block = replaceOnce(block,
      '\t\t\tconst view = block.callView;\n'
        + '\t\t\tif (view !== null && view.card === "terminal") return view.title ?? "";\n'
        + '\t\t\tconst raw = rawOf(block);',
      '\t\t\tconst raw = rawOf(block);');
    return replaceOnce(block,
      '\t\t\tconst view = block.callView;\n'
        + '\t\t\tif (view !== null) {\n'
        + '\t\t\t\tif (view.card === "diff") return K.write;\n'
        + '\t\t\t\tif (view.card === "generic" && view.kind !== void 0) {\n'
        + '\t\t\t\t\tconst mapped = GENERIC_KIND_BADGE[view.kind];\n'
        + '\t\t\t\t\tif (mapped !== void 0) return mapped;\n'
        + '\t\t\t\t}\n'
        + '\t\t\t}\n'
        + '\t\t\treturn K.other;',
      '\t\t\treturn K.other;');
  });
  return output;
}
