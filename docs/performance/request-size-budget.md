# Request size budget

API request bodies have a fixed maximum size. Keep client uploads below that ceiling and reject oversized requests before expensive parsing or model work begins.

When changing the limit, update the client-side validation and deployment documentation together so the browser and server enforce the same practical boundary.
