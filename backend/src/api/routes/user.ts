import {
  createUserSchema,
  listUsersQueryShape,
  paginationQueryShape,
  updateUserSchema,
} from "@app/contracts";

import { route, routes } from "../../lib/app-context.ts";
import { getEntityManager } from "../../lib/db.ts";
import { createUserRepository } from "../../user/user-repository.ts";
import { toUserResponse } from "../../user/user-response.ts";
import { CannotModifySelf, UserEmailTaken, UserNotFound } from "./errors.ts";

/**
 * The example API. Copy the shape, replace the domain.
 *
 * Each route declares its query/body schema, so validation happens once, in
 * the adapter, before the handler runs -- a handler never re-checks its own
 * input, and `query` / `body` arrive fully typed from the schema with no cast.
 *
 * Nothing here touches the EntityManager beyond handing it to the repository.
 * A handler's job is authorization against the caller, turning a null result
 * into the right status code, and mapping the entity to a response -- not
 * deciding which fields may change or what "deleted" means.
 */
export const userRoutes = routes(
  route("/users", "GET", {
    query: { ...paginationQueryShape, ...listUsersQueryShape },
    handler: async ({ query, c }) => {
      const em = await getEntityManager();
      const result = await createUserRepository(em).list(query);

      return c.json(
        {
          items: result.items.map(toUserResponse),
          page: result.page,
          pageSize: result.pageSize,
          total: result.total,
        },
        200,
      );
    },
  }),

  route("/users/:id", "GET", {
    handler: async ({ params, c }) => {
      const em = await getEntityManager();
      const user = await createUserRepository(em).findById(Number(params.id));

      if (!user) {
        throw UserNotFound();
      }

      return c.json(toUserResponse(user), 200);
    },
  }),

  route("/users", "POST", {
    body: createUserSchema,
    handler: async ({ body, c }) => {
      const em = await getEntityManager();
      const user = await createUserRepository(em).create(body);

      // null, not an exception: losing the email check is an ordinary outcome
      // the API has to render, not an error condition.
      if (!user) {
        throw UserEmailTaken();
      }

      return c.json(toUserResponse(user), 201);
    },
  }),

  route("/users/:id", "PATCH", {
    body: updateUserSchema,
    handler: async ({ params, body, c }) => {
      // Authorization, so it stays here: it is about the caller, not about the
      // row. An admin suspending their own account locks everyone out of the
      // thing only they can undo -- cheap guard, expensive incident. Checked
      // against the path id rather than a loaded entity, so it costs no query.
      if (c.get("actor").sub === params.id && body.status === "suspended") {
        throw CannotModifySelf();
      }

      const em = await getEntityManager();
      const user = await createUserRepository(em).update(Number(params.id), body);

      if (!user) {
        throw UserNotFound();
      }

      return c.json(toUserResponse(user), 200);
    },
  }),

  route("/users/:id", "DELETE", {
    handler: async ({ params, c }) => {
      if (c.get("actor").sub === params.id) {
        throw CannotModifySelf();
      }

      const em = await getEntityManager();
      const deleted = await createUserRepository(em).softDelete(Number(params.id));

      if (!deleted) {
        throw UserNotFound();
      }

      return c.body(null, 204);
    },
  }),
);
