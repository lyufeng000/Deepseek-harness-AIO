import { createHash } from 'node:crypto';

// Exact public dependency bytes, not package-wide exceptions. These contain
// upstream build metadata, documentation examples, or parser/grammar literals.
// Any changed byte or different path goes through normal credential scanning.
export const reviewedPublicContent = new Map([
  ['@koromix/koffi-win32-x64/win32_x64/koffi.node', '3f92d8794a051e2b873e8201bcbb66b0049e4b44d93a76e38ec9b1e588976ebe'],
  ['@mixmark-io/domino/test/domino.js', '6cd426edadca6763cbd4c911ab3e51caac45b1abaf3091b6666ae2e562d370b4'],
  ['@shikijs/langs/dist/emacs-lisp.mjs', '08bd4b92972b883409bbc4c50911bc9ab67e12c979d6e8101e72e532f303ac1f'],
  ['@types/node/fs.d.ts', '6d81823c5704398a68b98e3c7a459334fc0403ad5e6953f4317b5b4919e289e4'],
  ['@types/node/http.d.ts', 'baa9cafc61ef8b42b6e8f7a1aa1f75841ec9c9d2f59229277ed282ccb99b72c9'],
  ['@types/node/https.d.ts', '2c2bdaa1d8ead9f68628d6d9d250e46ee8e81aa4898b4769a36956ae15e060fe'],
  ['@types/node/url.d.ts', '8e2577e7262051fd3c5bd6ca2b2056d358ff8853565720f92455860824c25188'],
  ['fast-uri/test/fixtures/uri-js-parse.json', 'c954f79d2fa7f4d9779a6e7514cdf8df1eeb95d0097ea62cd3b785d20f2d0859'],
  ['jose/dist/webapi/key/import.js', 'ab2f57a9db99e8d48451a8d0a8adf75379381f65b0e3e28ba6c02aa5bb3ee5fa'],
  ['undici/docs/docs/api/Socks5ProxyAgent.md', 'c335f2224671d055841cb4b63563ba5bcc35dabc2ca76b2489d6a6da17e48f47'],
  ['wsl-utils/index.d.ts', '14cc3f4786d5d2760c2f51ec236e2d9029572dc2894b10e939da1f4acb0c0d1d'],
  ['wsl-utils/readme.md', '91c37129770a9054fd1280f65980698984cd1d1c22013058542ab2716eed03a7'],
  ['zod/src/v4/classic/tests/string.test.ts', 'b7027e6060924244ba62d33c4bb90527c37b255357e1374cc7a5a16e5b36a3bf'],
  ['dsh-smooth-stream/lib/client.js', '23a4e4ed4f3a8230baebd64209f86798de9a9bcada4cfabcda84b64a5a1bbc11'],
  ['dsh-usage-skill/README.md', '059a88615816a7c3abf6b4158c1e80c97eaf73a892990d47684abd2bd5689319'],
]);

export const reviewedPublicAlternates = [
  { file: '@koromix/koffi-win32-x64/win32_x64/koffi.node', version: '3.2.1', sha256: '8623dc57f3093a457f71fcbe31fad77741f5b648d8015f7c1dac959595f0972b' },
  { file: '@types/node/fs.d.ts', version: '26.5.0', sha256: '9d37b8a9678efbcdf38238b59ce8e6f7db70aba1a516f3a4a671a301dbacfb3d' },
  { file: '@types/node/http.d.ts', version: '26.5.0', sha256: 'ad50512520720d10294c629cb4e2df23891c3fcbeaca00fbfb9e6bbea65f3dd6' },
  { file: 'undici/docs/docs/api/Socks5ProxyAgent.md', version: '8.10.2', sha256: 'c9518591d0df4f741e0509383941f6bc3d8f53afda2e16eca64cb8eb3aac2b21' },
];

const telemetry = {
  'experimental_attributes.d.ts': ['4755d51a9a47fcc934aed639653acd919e96bedd0a0e072259020825e4216612'],
  'stable_attributes.d.ts': ['1c4563e4618aa59f076443e009ad212af07446a13728ed3130ab7c96dc104e98'],
  'trace/SemanticAttributes.d.ts': ['18ad8f49eddd1c5555b989c3eb48d376359852f460cc8a3b20d1f2f5e04b9b02'],
  'experimental_attributes.js': ['f54ca8e6872115818943ec484ab92e5ce9fb2c5c7ea9b093c4123f940583e4be', '18e9b78725c08761537a4b0161236e69eb68e68c1037587c5a83fce411b0238c'],
  'stable_attributes.js': ['b5cac33558fa03371d8b74981e8e8bd69aee9d423aac0c74a1a1d53c4e29b09d', 'd6e1ba3d97d5cd782dbf8205ef54f10412941201bd465eae068797d6f5ceac61'],
  'trace/SemanticAttributes.js': ['b614526ad590d2b2f92ab48fc0b7210550f021aedb3f776350980c658e6c2deb', 'fe54c0a216df0a2b4b8ed8056002cb66a11a12b908ac0ba2afc38e5ee499966e'],
};
for (const format of ['esm', 'esnext', 'src']) {
  for (const [name, hashes] of Object.entries(telemetry)) {
    reviewedPublicContent.set(`@opentelemetry/semantic-conventions/build/${format}/${name}`,
      hashes[format === 'src' && hashes.length > 1 ? 1 : 0]);
  }
}

export function isReviewedPublicContent(relative, bytes) {
  const prefix = 'profiles/web-desktop/node_modules/';
  if (!relative.startsWith(prefix)) return false;
  const file = relative.slice(prefix.length);
  const expected = [reviewedPublicContent.get(file),
    ...reviewedPublicAlternates.filter(item => item.file === file).map(item => item.sha256)].filter(Boolean);
  return expected.length > 0 && expected.includes(createHash('sha256').update(bytes).digest('hex'));
}
