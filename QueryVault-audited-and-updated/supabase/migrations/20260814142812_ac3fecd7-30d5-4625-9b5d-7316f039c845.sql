REVOKE EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_operator(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.observability_summary(integer) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_operator(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.observability_summary(integer) TO authenticated, service_role;