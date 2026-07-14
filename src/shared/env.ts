// Copy an environment for child-process spawn, dropping undefined entries so the spawn env is a
// clean string map rather than inheriting explicit-undefined keys.
export function copyEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined>): NodeJS.ProcessEnv {
  const copied: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      copied[key] = value;
    }
  }
  return copied;
}
