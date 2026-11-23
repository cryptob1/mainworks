// GY-3573: Graphyard is now Mainworks; every setting is read under the new name first. No Node imports, so the web bundle can use it.
/**
 * The one helper every setting goes through: MAINWORKS_<NAME>, else GRAPHYARD_<NAME> (NAME may carry the GRAPHYARD_ prefix). It only reads;
 * the environment is never rewritten, so child processes inherit it as it is.
 */
export function setting(name: string, env: Record<string, string | undefined> = process.env) {
  const bare = name.replace(/^GRAPHYARD_/, '');
  return env[`MAINWORKS_${bare}`] ?? env[`GRAPHYARD_${bare}`];
}
