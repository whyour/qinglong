export interface ValidationErrorResponse {
  errors?: Array<{ message?: string; value?: unknown }>;
  validation?: Record<
    string,
    { source?: string; keys?: string[]; message?: string }
  >;
}

export const getErrorDetails = (data?: ValidationErrorResponse) => {
  const details =
    data?.errors?.map((item) =>
      item.value === undefined
        ? item.message
        : `${item.message} (${String(item.value)})`,
    ) || [];

  Object.values(data?.validation || {}).forEach((validation) => {
    if (validation.keys?.length) {
      validation.keys.forEach((key) => {
        details.push(
          validation.message ? `${key}: ${validation.message}` : key,
        );
      });
    } else if (validation.message) {
      details.push(validation.message);
    }
  });

  return details.filter((detail): detail is string => Boolean(detail));
};
