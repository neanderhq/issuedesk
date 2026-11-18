import { runRoute, validateMutation } from "../../../server/http";
import { trackerApiRoute } from "../../../server/tracker-api";

type RouteContext = { params: Promise<{ tracker: string[] }> };

export const dynamic = "force-dynamic";

async function route(request: Request, context: RouteContext) {
  return runRoute(`tracker-${request.method.toLowerCase()}`, async () => {
    const { tracker } = await context.params;
    const csvMultipartMutation = tracker[0] === "issues" && tracker[1] === "csv" && tracker.length === 3 && ["preview", "import"].includes(tracker[2]) && request.method === "POST";
    if (request.method !== "GET" && !csvMultipartMutation) {
      const invalid = await validateMutation(request);
      if (invalid) return invalid;
    }
    return trackerApiRoute(request, tracker);
  });
}

export const GET = route;
export const POST = route;
export const PATCH = route;
export const DELETE = route;
