// GY-3573: Graphyard is now Mainworks; every setting is read under the new name first. No Node imports, so the web bundle can use it.
/**
 * The one helper every setting goes through: MAINWORKS_<NAME>, else GRAPHYARD_<NAME>. It only reads;
 * the environment is never rewritten, so child processes inherit it as it is.
 */
export const setting = (name: string, env: Record<string, string | undefined> = process.env) => env[`MAINWORKS_${name}`] ?? env[`GRAPHYARD_${name}`];
