// Reviewed WebUI 0.5.1 only. Owners verified at upstream c389f96 / alpha.2:
// SessionSnapshot lifecycle; ChatSnapshot.legacy timings/partial; InputState.
const oldFace = `const faceRef = (0, react.useRef)(props);
\t\t\tfaceRef.current = props;`;
const newFace = `const session = props.useSession((snapshot) => snapshot);
\t\t\tconst chat = props.useChat((snapshot) => snapshot);
\t\t\tconst input = props.useInput((snapshot) => snapshot);
\t\t\tconst face = {
\t\t\t\t...props,
\t\t\t\tsession: { ...session, chat, turnTimings: chat.legacy.turnTimings, partial: chat.legacy.partial },
\t\t\t\tinput
\t\t\t};
\t\t\tconst faceRef = (0, react.useRef)(face);
\t\t\tfaceRef.current = face;`;

function replaceRegion(source, start, replacements) {
  const from = source.indexOf(start);
  const to = source.indexOf('//#endregion', from);
  if (from < 0 || to < from || source.indexOf(start, from + start.length) >= 0) {
    throw new Error(`Unrecognized WebUI continue/stats region: ${start}`);
  }
  const original = source.slice(from, to);
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  let region = original.replace(/\r\n/g, '\n');
  for (const [old, current] of replacements) {
    if (region.includes(current) && !region.includes(old)) continue;
    if (region.split(old).length !== 2) {
      throw new Error(`Unrecognized WebUI continue/stats boundary: ${old}`);
    }
    region = region.replace(old, current);
  }
  return source.slice(0, from) + region.replace(/\n/g, newline) + source.slice(to);
}

export function migrateWebuiContinue(source) {
  let output = replaceRegion(source, 'function ComposerContinueEnhancer(props)', [[oldFace, newFace]]);
  output = replaceRegion(output, 'const StatsLineShadow = ', [
    ['StatsLineShadow({ useSession, useProjection, t })', 'StatsLineShadow({ useChat, useProjection, t })'],
    ['useSession((s) => s.chat.legacy.nodes)', 'useChat((s) => s.legacy.nodes)'],
  ]);
  return output;
}
