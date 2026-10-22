export type Query = Record<string, any>;
export type QuerySpec = {
  where: Query;
  orderBy?: Record<string, string>[];
  offset?: number;
  limit?: number;
};

export function orderBy(order: string[][]): Record<string, string>[] {
  return order.map(([field, direction]) => {
    if (!/^(asc|desc)$/i.test(direction))
      throw new Error('Invalid sort direction');
    return { [field]: direction.toLowerCase() };
  });
}

export function textSearch(fields: string[], text: string): Query {
  return {
    $or: fields.flatMap((field) =>
      [...new Set([text, encodeURI(text)])].map((value) => ({
        [field]: { $like: `%${value}%` },
      })),
    ),
  };
}
