# Image analysis boundaries

Image-analysis requests should accept only explicitly supported image formats and enforce a strict payload-size ceiling before calling the model provider.

Malformed input should return a client error. Uploaded image bytes should not be persisted or included in application logs unless a separate feature explicitly requires that behavior.
