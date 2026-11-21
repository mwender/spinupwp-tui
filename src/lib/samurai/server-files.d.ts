// The gate and its installer are shell scripts embedded as text (see gate.ts).
declare module "*/spinuptui-nginx" {
  const text: string
  export default text
}
declare module "*.sh" {
  const text: string
  export default text
}
