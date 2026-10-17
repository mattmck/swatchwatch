/**
 * Image proxy configuration error, in its own module so both `lib/image-proxy` and
 * `lib/blob-storage` can throw it without a circular import. Re-exported by `lib/image-proxy`.
 */

/** The signing key or the container layout is missing or unusable. Map to a generic 5xx; never serve. */
export class ImageProxyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageProxyConfigError";
  }
}
