// The page imports the ElevenLabs client at runtime from a pinned jsDelivr URL (no bundler).
// This declaration gives that exact specifier the types of the @elevenlabs/client@1.26.0 devDependency.
// Keep the version in the URL, in package.json and in lab.ts identical.
declare module 'https://cdn.jsdelivr.net/npm/@elevenlabs/client@1.26.0/+esm' {
  export * from '@elevenlabs/client';
}
