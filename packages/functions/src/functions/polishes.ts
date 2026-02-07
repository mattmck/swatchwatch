import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";

interface Polish {
  id?: string;
  brand: string;
  name: string;
  color: string;
  finish?: string;
  collection?: string;
  quantity?: number;
  notes?: string;
}

async function getPolishes(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log("GET /api/polishes - Listing polishes");

  const id = request.params.id;

  if (id) {
    // TODO: Fetch single polish from Cosmos DB by id
    context.log(`Fetching polish with id: ${id}`);
    return {
      status: 200,
      jsonBody: { message: `Polish ${id} would be returned here` },
    };
  }

  // TODO: Fetch all polishes from Cosmos DB
  return {
    status: 200,
    jsonBody: { message: "List of polishes would be returned here", polishes: [] },
  };
}

async function createPolish(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log("POST /api/polishes - Creating polish");

  try {
    const body = (await request.json()) as Polish;

    if (!body.brand || !body.name || !body.color) {
      return {
        status: 400,
        jsonBody: { error: "Missing required fields: brand, name, color" },
      };
    }

    // TODO: Insert into Cosmos DB
    context.log(`Creating polish: ${body.brand} - ${body.name}`);
    return {
      status: 201,
      jsonBody: { message: "Polish created", polish: body },
    };
  } catch {
    return {
      status: 400,
      jsonBody: { error: "Invalid request body" },
    };
  }
}

async function updatePolish(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log("PUT /api/polishes - Updating polish");

  const id = request.params.id;
  if (!id) {
    return {
      status: 400,
      jsonBody: { error: "Polish id is required" },
    };
  }

  try {
    const body = (await request.json()) as Partial<Polish>;

    // TODO: Update in Cosmos DB
    context.log(`Updating polish with id: ${id}`);
    return {
      status: 200,
      jsonBody: { message: `Polish ${id} updated`, polish: { id, ...body } },
    };
  } catch {
    return {
      status: 400,
      jsonBody: { error: "Invalid request body" },
    };
  }
}

async function deletePolish(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log("DELETE /api/polishes - Deleting polish");

  const id = request.params.id;
  if (!id) {
    return {
      status: 400,
      jsonBody: { error: "Polish id is required" },
    };
  }

  // TODO: Delete from Cosmos DB
  context.log(`Deleting polish with id: ${id}`);
  return {
    status: 200,
    jsonBody: { message: `Polish ${id} deleted` },
  };
}

app.http("polishes-list", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "polishes/{id?}",
  handler: getPolishes,
});

app.http("polishes-create", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "polishes",
  handler: createPolish,
});

app.http("polishes-update", {
  methods: ["PUT"],
  authLevel: "anonymous",
  route: "polishes/{id}",
  handler: updatePolish,
});

app.http("polishes-delete", {
  methods: ["DELETE"],
  authLevel: "anonymous",
  route: "polishes/{id}",
  handler: deletePolish,
});
