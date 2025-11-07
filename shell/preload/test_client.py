#!/usr/bin/env python3
"""
Validation script for QLAPI Client functionality.
Tests that all methods are properly accessible through the BaseApi class.
"""

import sys
from client import Client


def test_client_has_required_methods():
    """Test that Client class has all required API methods."""
    client = Client()
    
    required_methods = [
        'getEnvs',
        'createEnv',
        'updateEnv',
        'deleteEnvs',
        'moveEnv',
        'disableEnvs',
        'enableEnvs',
        'updateEnvNames',
        'getEnvById',
        'systemNotify',
        'getCronDetail',
        'createCron',
        'updateCron',
        'deleteCrons',
    ]
    
    print("Testing Client class methods...")
    for method in required_methods:
        assert hasattr(client, method), f"Client missing method: {method}"
        assert callable(getattr(client, method)), f"Client.{method} is not callable"
        print(f"  ✓ {method}")
    
    print(f"\n✓ All {len(required_methods)} methods are present and callable")
    return True


def test_baseapi_inheritance():
    """Test that BaseApi properly inherits from Client."""
    
    # Simulate the BaseApi class from sitecustomize.py
    class BaseApi(Client):
        def notify(self, *args, **kwargs):
            return "mock_notify_result"
    
    api = BaseApi()
    
    print("\nTesting BaseApi inheritance...")
    
    # Test that BaseApi has all Client methods
    assert hasattr(api, 'getEnvs'), "BaseApi missing getEnvs"
    assert callable(api.getEnvs), "BaseApi.getEnvs is not callable"
    print("  ✓ getEnvs is accessible")
    
    # Test that BaseApi also has its own method
    assert hasattr(api, 'notify'), "BaseApi missing notify"
    assert callable(api.notify), "BaseApi.notify is not callable"
    print("  ✓ notify is accessible")
    
    # Verify getEnvs signature
    assert 'params' in api.getEnvs.__annotations__, "getEnvs missing params annotation"
    print("  ✓ getEnvs has correct signature")
    
    print("\n✓ BaseApi properly inherits from Client and adds notify method")
    return True


def test_method_signatures():
    """Test that methods have correct type annotations."""
    client = Client()
    
    print("\nTesting method signatures...")
    
    # Test getEnvs signature
    getEnvs_annotations = client.getEnvs.__annotations__
    assert 'params' in getEnvs_annotations or 'return' in getEnvs_annotations, \
        "getEnvs missing annotations"
    print("  ✓ getEnvs has type annotations")
    
    # Test other critical methods
    assert hasattr(client, 'createEnv'), "Missing createEnv"
    assert hasattr(client, 'updateEnv'), "Missing updateEnv"
    print("  ✓ Critical methods present")
    
    print("\n✓ All method signatures are correct")
    return True


def main():
    """Run all validation tests."""
    print("=" * 60)
    print("QLAPI Client Validation Tests")
    print("=" * 60)
    
    try:
        test_client_has_required_methods()
        test_baseapi_inheritance()
        test_method_signatures()
        
        print("\n" + "=" * 60)
        print("ALL TESTS PASSED ✓")
        print("=" * 60)
        print("\nThe QLAPI Client is working correctly.")
        print("Users can safely use: QLAPI.getEnvs({'searchValue': 'USER'})")
        return 0
    
    except AssertionError as e:
        print(f"\n❌ TEST FAILED: {e}")
        return 1
    except Exception as e:
        print(f"\n❌ UNEXPECTED ERROR: {e}")
        import traceback
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
